import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToMarkdown, markdownToAdf, adfBody, typeCategory, stateCategory, linkKind, currentSprint, isoUtc, decodeCursor, encodeCursor, buildJql, keyOf } from '../dist/index.js';
import { load } from './replay.ts';

const doc = (...content: unknown[]) => ({ version: 1, type: 'doc', content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const tx = (text: string, ...marks: string[]) => ({ type: 'text', text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });

test('ADF → markdown: the recorded epic description', () => {
  const pages = load('pull-full.json');
  const epic = pages.flatMap((pg) => (pg.response as { issues: { key: string; fields: { description: unknown } }[] }).issues).find((i) => i.key === 'KAN-4')!;
  assert.equal(adfToMarkdown(epic.fields.description), [
    '## Invoice submission',
    'A contractor submits an invoice from the **portal**; see [the spec](https://example.com/spec). Owner: @Farsight Test.',
    '- validate totals\n- call `finalizeInvoice`',
    '1. draft\n2. submit\n   then approve',
    '```ts\nawait finalizeInvoice(id);\n```',
    '| step | owner |\n| --- | --- |\n| submit | contractor |',
  ].join('\n\n'));
});

test('ADF → markdown: media is a reference, never bytes; mentions, emoji, dates, status, cards, quotes, rules, tasks, nesting', () => {
  const d = doc(
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'abc-123', type: 'file', collection: 'x', alt: 'screenshot.png' } }] },
    { type: 'mediaGroup', content: [{ type: 'media', attrs: { id: 'f-1', type: 'file' } }] },
    p({ type: 'mention', attrs: { id: '712020:x', text: 'Ann' } }, tx(' '), { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }, tx(' '),
      { type: 'date', attrs: { timestamp: '1790726400000' } }, tx(' '), { type: 'status', attrs: { text: 'BLOCKED', color: 'red' } }, tx(' '),
      { type: 'inlineCard', attrs: { url: 'https://x.test/a' } }),
    { type: 'blockquote', content: [p(tx('quoted'))] },
    { type: 'rule' },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [tx('shipped')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [tx('verify')] }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(tx('outer')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(tx('inner'))] }] }] }] },
    { type: 'panel', attrs: { panelType: 'info' }, content: [p(tx('in a panel', 'em'))] },
    { type: 'expand', attrs: { title: 'More' }, content: [p(tx('hidden', 'strike'))] },
    { type: 'unknownFutureNode', content: [p(tx('still read'))] },
  );
  assert.equal(adfToMarkdown(d), [
    '[attachment: screenshot.png]',
    '[attachment: f-1]',
    '@Ann 😄 2026-09-30 [BLOCKED] https://x.test/a',
    '> quoted',
    '---',
    '- [x] shipped\n- [ ] verify',
    '- outer\n  - inner',
    '*in a panel*',
    '**More**\n\n~~hidden~~',
    'still read',
  ].join('\n\n'));
});

test('ADF → markdown tolerates null, a v2 wiki string and an empty doc', () => {
  assert.equal(adfToMarkdown(null), '');
  assert.equal(adfToMarkdown('h1. wiki'), 'h1. wiki');
  assert.equal(adfToMarkdown(doc()), '');
  assert.equal(adfBody(null), undefined);
  assert.deepEqual(adfBody('plain'), { format: 'wiki', raw: 'plain', text: 'plain' });
  assert.equal(adfBody(doc(p(tx('x'))))!.format, 'adf');
});

test('markdown → ADF: the nodes Farsight writes', () => {
  const d = markdownToAdf('# Title\n\nSome **bold**, *em*, _em2_, ~~gone~~, `code` and [a link](https://x.test).\nsecond line\n\n- one\n- two\n  - nested\n\n3. three\n4. four\n\n```js\nlet a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(d.type, 'doc');
  assert.equal(d.version, 1);
  const types = d.content.map((n) => n.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'bulletList', 'orderedList', 'codeBlock', 'table']);
  const para = d.content[1]!.content!;
  const marked = (m: string) => para.filter((n) => n.marks?.some((x) => x.type === m)).map((n) => n.text);
  assert.deepEqual(marked('strong'), ['bold']);
  assert.deepEqual(marked('em'), ['em', 'em2']);
  assert.deepEqual(marked('strike'), ['gone']);
  assert.deepEqual(marked('code'), ['code']);
  assert.deepEqual(para.find((n) => n.text === 'a link')!.marks, [{ type: 'link', attrs: { href: 'https://x.test' } }]);
  assert.ok(para.some((n) => n.type === 'hardBreak'), 'a line break inside a paragraph is a hardBreak');
  assert.deepEqual(d.content[3]!.attrs, { order: 3 });
  assert.deepEqual(d.content[4]!.attrs, { language: 'js' });
  assert.equal(d.content[5]!.content![0]!.content![0]!.type, 'tableHeader');
  assert.equal(d.content[5]!.content![1]!.content![0]!.type, 'tableCell');
});

test('round trip: markdown → ADF → markdown is the identity on the subset Farsight writes', () => {
  const corpus = [
    'plain text',
    '# H1\n\n## H2 with `code`',
    'line one\nline two',
    '**bold** and *em* and ~~strike~~ and `code` and [link](https://x.test/a?b=c)',
    '- a\n- b\n- c',
    '1. first\n2. second',
    '- outer\n  - inner\n- back',
    '```\nno language\n```',
    '```ts\nconst x = 1;\n\nconsole.log(x);\n```',
    '| h1 | h2 |\n| --- | --- |\n| c1 | c2 |',
    '> a quote',
    '---',
    'para\n\n- list\n\nafter',
    'via Farsight (agent): the POST /invoices route has no test — see [KAN-1](https://example.atlassian.net/browse/KAN-1).',
  ];
  for (const md of corpus) assert.equal(adfToMarkdown(markdownToAdf(md)), md, md);
});

test('round trip: the recorded ADF bodies survive ADF → markdown → ADF → markdown', () => {
  const pages = load('pull-full.json').concat(load('hydrate.json'));
  const bodies: unknown[] = [];
  for (const pg of pages) {
    const r = pg.response as { issues?: { fields: { description?: unknown } }[]; comments?: { body: unknown }[] };
    for (const i of r.issues ?? []) if (i.fields?.description) bodies.push(i.fields.description);
    for (const c of r.comments ?? []) bodies.push(c.body);
  }
  assert.ok(bodies.length >= 3);
  for (const b of bodies) {
    const md = adfToMarkdown(b);
    assert.equal(adfToMarkdown(markdownToAdf(md)), md);
  }
});

test('categories: §3 rules only', () => {
  assert.equal(stateCategory('new'), 'todo');
  assert.equal(stateCategory('indeterminate'), 'in-progress');
  assert.equal(stateCategory('done'), 'done');
  assert.equal(stateCategory('undefined'), 'todo', 'Jira’s own "No Category"');
  assert.equal(typeCategory({ name: 'Initiative', hierarchyLevel: 2 }), 'epic');
  assert.equal(typeCategory({ name: 'Epic', hierarchyLevel: 1 }), 'epic');
  assert.equal(typeCategory({ name: 'Sub-task', subtask: true, hierarchyLevel: -1 }), 'task');
  assert.equal(typeCategory({ name: 'Bug', hierarchyLevel: 0 }), 'bug');
  assert.equal(typeCategory({ name: 'Story', hierarchyLevel: 0 }), 'story');
  assert.equal(typeCategory({ name: 'Task', hierarchyLevel: 0 }), 'task');
  assert.equal(typeCategory({ name: 'Improvement', hierarchyLevel: 0 }), 'other');
  assert.equal(linkKind('Blocks', 'outward'), 'blocks');
  assert.equal(linkKind('Blocks', 'inward'), 'blocked-by');
  assert.equal(linkKind('Duplicate', 'outward'), 'duplicates');
  assert.equal(linkKind('Duplicate', 'inward'), 'other', 'the closed set has no duplicated-by');
  assert.equal(linkKind('Cloners', 'outward'), 'other');
});

test('sprint: the active one, else the last; dates to ISO UTC', () => {
  assert.equal(currentSprint(null), undefined);
  assert.deepEqual(currentSprint([{ name: 'S1', state: 'closed' }, { name: 'S2', state: 'active', startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-15T00:00:00.000Z' }, { name: 'S3', state: 'future' }]),
    { name: 'S2', start: '2026-09-01T00:00:00.000Z', end: '2026-09-15T00:00:00.000Z' });
  assert.deepEqual(currentSprint([{ name: 'S1', state: 'closed' }, { name: 'S3', state: 'future' }]), { name: 'S3' });
  assert.equal(isoUtc('2026-09-30T18:32:46.656-0400'), '2026-09-30T22:32:46.656Z');
  assert.equal(isoUtc(1790807566656), '2026-09-30T22:32:46.656Z');
});

test('cursor and JQL: epoch-ms bound, quoted keys, bare ISO accepted', () => {
  const c = encodeCursor({ v: 1, at: 1790807566656, seen: ['10010@1790807566656'] });
  assert.deepEqual(decodeCursor(c), { v: 1, at: 1790807566656, seen: ['10010@1790807566656'] });
  assert.equal(decodeCursor('2026-09-30T22:32:46.656Z')!.at, 1790807566656);
  assert.equal(decodeCursor('junk'), null);
  assert.equal(buildJql(['KAN'], { since: 1790807566656.7, areas: ['Portal "x"'] }), 'project in ("KAN") AND component in ("Portal \\"x\\"") AND updated >= 1790807566656 ORDER BY updated ASC');
  assert.equal(keyOf('work::acme-jira::ACME-12'), 'ACME-12');
});

test('markdown → ADF edges: snake_case is not emphasis, a list may follow a line, code takes no other mark', () => {
  const snake = markdownToAdf('rename foo_bar_baz to qux, keep _this_');
  const inline = snake.content[0]!.content!;
  assert.equal(inline[0]!.text, 'rename foo_bar_baz to qux, keep ');
  assert.deepEqual(inline[1], { type: 'text', text: 'this', marks: [{ type: 'em' }] });
  assert.deepEqual(markdownToAdf('Steps:\n- one\n- two').content.map((n) => n.type), ['paragraph', 'bulletList']);
  assert.deepEqual(markdownToAdf('in 2026\n3. not a list').content.map((n) => n.type), ['paragraph'], 'an ordered list interrupts a paragraph only from 1');
  assert.deepEqual(markdownToAdf('**`x`**').content[0]!.content![0]!.marks, [{ type: 'code' }]);
  assert.deepEqual(markdownToAdf('[`x`](https://x.test)').content[0]!.content![0]!.marks, [{ type: 'code' }, { type: 'link', attrs: { href: 'https://x.test' } }]);
});
