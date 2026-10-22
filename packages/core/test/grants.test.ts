import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideGrants, type GrantLike } from '../dist/index.js';

// The boundary, not the rules (Work's and the code host's suites own those): importable without Work, over a
// grant shape no tracker defines. Work's test/shared-grants.test.ts pins that Work re-exports this one function.

test('the matcher imports nothing, so a consumer gets no tracker, session or I/O with it', () => {
  const src = readFileSync(new URL('../dist/grants.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s|\bimport\(|\brequire\(/m);
});

test('a non-tracker grant shape is decided with its own target check', () => {
  type Grant = GrantLike<'dispose' | 'promote'> & { rules?: string[] };
  const grants: Grant[] = [
    { actions: ['dispose'], principals: ['agent'], rules: ['js/sql'] },
    { actions: ['dispose'], principals: ['agent'], confirm: 'never' },
  ];
  const miss = (rule: string) => (g: Grant) => (g.rules && !g.rules.includes(rule) ? `the grant does not cover ${rule}` : null);
  const d = decideGrants(grants, 'dispose', 'agent', { miss: miss('js/xss') });
  assert.equal(d.verdict.allowed, true);
  assert.equal(d.grant, grants[1]);
  assert.equal(d.requiresConfirmation, false);
  assert.deepEqual(decideGrants(grants, 'promote', 'agent').verdict, { allowed: false, reason: 'no grant allows promote' });
  assert.equal(decideGrants(grants.slice(0, 1), 'dispose', 'agent', { miss: miss('js/xss') }).verdict.reason, 'the grant does not cover js/xss');
});
