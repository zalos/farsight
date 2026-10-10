// Code hosts behind the three verdicts (round 2026-10-10, proposal 6): the policy reads `allow`, default deny,
// read-only sources post nothing, agents need confirmation, and a pull request file's patch becomes ranges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeHostPolicy, agentsMayRead, rangesOfFilePatch, decidePost, type CodeHostSource } from '../dist/index.js';

const src = (over: Partial<CodeHostSource> = {}): CodeHostSource => ({ id: 'gh', type: 'code-host', host: 'github', repo: 'example-org/invoice-app', ...over });

test('default deny: no allow list, no grant', () => {
  assert.equal(codeHostPolicy(src(), 'read', 'human').verdict.allowed, false);
  assert.equal(codeHostPolicy(undefined, 'comment', 'human').verdict.allowed, false);
  assert.equal(agentsMayRead([src()]), false);
});

test('a read-only source posts nothing, whatever it allows', () => {
  const d = codeHostPolicy(src({ allow: { people: ['read', 'comment', 'check'] } }), 'comment', 'human');
  assert.equal(d.verdict.allowed, false);
  assert.match(d.verdict.reason, /read-only/);
});

test('an edit source grants people what it lists, and a post waits for a person', () => {
  const s = src({ mode: 'edit', allow: { people: ['read', 'comment', 'check'], agents: ['read'] } });
  const d = codeHostPolicy(s, 'comment', 'human');
  assert.equal(d.verdict.allowed, true);
  assert.equal(d.requiresConfirmation, true, 'a post is confirmed by default');
  assert.equal(codeHostPolicy(s, 'comment', 'agent').verdict.allowed, false, 'agents only read');
  assert.equal(codeHostPolicy(s, 'read', 'agent').verdict.allowed, true);
  assert.equal(agentsMayRead([s]), true);
  assert.equal(codeHostPolicy({ ...s, confirm: 'never' }, 'check', 'human').requiresConfirmation, false);
});

test('the host is not asked when the policy says no', async () => {
  let asked = false;
  const d = await decidePost(src(), 'human', async () => { asked = true; throw new Error('no'); }, async () => { throw new Error('no'); });
  assert.equal(d.allowed, false);
  assert.equal(asked, false);
  assert.match(d.verdicts.tracker.reason, /not asked/);
});

test('a file patch becomes new-side ranges', () => {
  assert.deepEqual(rangesOfFilePatch('@@ -1,3 +1,4 @@\n a\n+b\n@@ -20 +21,0 @@\n-x'), [[1, 4], [21, 21]]);
  assert.deepEqual(rangesOfFilePatch(undefined), []);
});
