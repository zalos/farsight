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
