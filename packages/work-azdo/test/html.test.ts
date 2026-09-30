import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, markdownToHtml, decodeEntities } from '../dist/index.js';
import { rec } from './fake.ts';

test('html: paragraphs, headings, nested lists, code, links, bold/italic, br and tables', () => {
  assert.equal(htmlToText('<h2>Title</h2><p>one<br>two &amp; <b>bold</b> <i>it</i></p>'), '## Title\n\none\ntwo & **bold** *it*');
  assert.equal(htmlToText('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>'), '- a\n  - b\n- c');
  assert.equal(htmlToText('<ol><li>x</li><li>y</li></ol>'), '1. x\n2. y');
  assert.equal(htmlToText('<p>see <a href="https://x.test/a">the page</a> and <a href="https://y.test">https://y.test</a></p>'), 'see [the page](https://x.test/a) and https://y.test');
  assert.equal(htmlToText('<pre>a\n  b</pre><p>use <code>npm i</code></p>'), '```\na\n  b\n```\n\nuse `npm i`');
  assert.equal(htmlToText('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table>'), '| A | B |\n| --- | --- |\n| 1 | 2\\|3 |');
  assert.equal(htmlToText('<script>alert(1)</script><style>p{}</style><p>kept</p>'), 'kept');
  assert.equal(htmlToText(''), '');
  assert.equal(decodeEntities('&lt;&#39;&#x41;&nbsp;&bogus;'), "<'A &bogus;");
});

test('html: a recorded ExampleProject description renders as a readable nested list', () => {
  const d = rec('batch').value.find((v: any) => v.id === 350).fields['System.Description'];
  const text = htmlToText(d);
  assert.match(text, /^\*\*Info Required \/ Requested\*\*/);
  assert.match(text, /\n- Attachments\n  - Receipts, picture, etc\./);
  assert.match(text, /\[Example product safety notice .*\]\(https:\/\/example\.com\/notices\)/);
  assert.doesNotMatch(text, /<|&nbsp;|&amp;/);
});

test('html: markdown → HTML for description edits, and back', () => {
  const md = '# T\n\nsome **bold** and `a<b` [l](https://x.test)\n\n- a\n  - b\n- c\n\n1. x\n2. y';
  const html = markdownToHtml(md);
  assert.equal(html, '<h1>T</h1><p>some <strong>bold</strong> and <code>a&lt;b</code> <a href="https://x.test">l</a></p><ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol><li>x</li><li>y</li></ol>');
  assert.equal(htmlToText(html), md);
  assert.equal(markdownToHtml('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
});
