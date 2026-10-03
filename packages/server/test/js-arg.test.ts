/**
 * `jsArg()` (public/app/store.js): a value placed as a JS string argument inside an
 * HTML event-handler attribute. `esc()` alone is not enough there — the HTML parser
 * decodes `&#39;` back to `'` before the handler runs, so a node id, tag or file
 * path holding `');alert(1);('` would run as code. This test plays the parser:
 * decode the attribute, run the handler, and check the argument arrived whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as any;
g.window = g;
g.document = { body: { className: 'lens-hybrid surface-portfolio' } };
const { esc, jsArg } = await import(join(here, '..', 'public', 'app', 'store.js'));

/** what the browser hands the JS engine for `onclick="…"`: the attribute value, entities decoded */
const decodeAttr = (html: string) => {
  const m = /onclick="([^"]*)"/.exec(html);
  assert.ok(m, `one double-quoted onclick in ${html}`);
  return m![1]!.replace(/&(quot|#39|lt|gt|amp);/g, (_, e) => ({ quot: '"', '#39': "'", lt: '<', gt: '>', amp: '&' } as Record<string, string>)[e]!);
};

const HOSTILE = [
  "repo::src/a.ts::plain",
  "x');alert(1);('",
  'x");alert(1);("',
  "a\\');alert(1);//",
  '</button><img src=x onerror=alert(1)>',
  'tab\tnew\nline & amp; &#39;  ',
];

test('jsArg: the handler receives exactly the value, whatever it holds', () => {
  for (const value of HOSTILE) {
    const js = decodeAttr('<button onclick="f(' + jsArg(value) + ')">x</button>');
    const got: unknown[] = [];
    new Function('f', js)((v: unknown) => got.push(v));
    assert.deepEqual(got, [value], js);
  }
});

test('esc alone in a JS string does not hold — the reason jsArg exists', () => {
  const js = decodeAttr('<button onclick="f(\'' + esc("x');g('pwned") + '\')">x</button>');
  const calls: string[] = [];
  new Function('f', 'g', js)(() => calls.push('f'), () => calls.push('g'));
  assert.deepEqual(calls, ['f', 'g'], 'the decoded quote ends the string and a second call runs');
});
