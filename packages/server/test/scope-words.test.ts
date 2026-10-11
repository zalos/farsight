// The viewer's copy of the scope chip words equals core's (swarm round 3: a number without a verdict prints them too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SCOPE_WORDS, STRINGS } from '@farsight/core';

const here = dirname(fileURLToPath(import.meta.url));
const V = await import(join(here, '..', 'public', 'app', 'lib', 'scope-words.js'));

test('lib/scope-words.js says what core SCOPE_WORDS says, and every word is in the catalog', () => {
  assert.deepEqual(V.SCOPE_WORDS, SCOPE_WORDS);
  for (const k of Object.values(V.SCOPE_WORDS) as string[]) assert.ok(STRINGS[k]?.define, k);
  assert.equal(V.scopeWordKey('journey.scopeAll'), 'count.over.journey');
  assert.equal(V.scopeWordKey('count.scope.storyline'), 'count.scope.storyline');
});
