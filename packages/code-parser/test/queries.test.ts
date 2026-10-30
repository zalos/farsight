import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grammarQuery, grammarForFile } from '../dist/index.js';
import { grammarParser } from '../dist/treesitter/harness.js';

test('grammar queries share grammar loading, memoise by grammar and source, and capture source syntax', async () => {
  const query = '(call_expression function: (identifier) @name) @site';
  const first = await grammarQuery('typescript', query);
  assert.equal(first, await grammarQuery('typescript', query));
  assert.notEqual(first, await grammarQuery('javascript', query));
  const parse = await grammarParser('typescript');
  try {
    assert.equal(first.matches(parse('hello();')!)[0]?.captures.find((c) => c.name === 'name')?.node.text, 'hello');
  } finally {
    parse.dispose();
  }
  assert.equal(grammarForFile('src/a.mts'), 'typescript');
  assert.equal(grammarForFile('app.py'), 'python');
  assert.equal(grammarForFile('config.yaml'), undefined);
  await assert.rejects(grammarQuery('../anything', query), /Unsupported grammar/);
  await assert.rejects(grammarQuery('typescript', '(not_a_real_node)'));
});

test('query source and predicate strings are capped before compile, without deprecated Language.query warnings', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    await grammarQuery('typescript', '(identifier) @fresh');
    assert.equal(warn.mock.callCount(), 0);
    await assert.rejects(grammarQuery('typescript', ' '.repeat(4097)), /queryLength/);
    for (const predicate of ['match?', 'any-match?', 'not-match?', 'any-not-match?']) {
      await assert.rejects(
        grammarQuery('typescript', `((identifier) @name (#${predicate} @name "${'x'.repeat(513)}"))`),
        /predicateLength/,
      );
      await grammarQuery('typescript', `((identifier) @name (#${predicate} @name "${'x'.repeat(512)}"))`);
    }
    // A semicolon inside a literal is not a comment; a quoted comment is not a predicate.
    await assert.rejects(
      grammarQuery('typescript', `((identifier) @name (#match? @name ";${'x'.repeat(512)}"))`),
      /predicateLength/,
    );
    await grammarQuery('typescript', `; "${'x'.repeat(513)}"\n(identifier) @name`);
  } finally {
    warn.mock.restore();
  }
});
