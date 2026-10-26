// Gate tiers, swarm round 3 (2026-10-11): the auditor's reading. *Is somebody signed in* is plumbing every action
// meets — tier policy — while four-eyes, a duplicate check and two names that must agree are the controls an
// auditor asks about — tier business. A precondition's stored tier (the parser's copy of the old mapping) never
// overrides its class; a team's own tier (config or `@guard[tier]`) always does. Runs against `dist/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateTierOf, TIER_OF_CLASS } from '../dist/index.js';
import type { GraphNode } from '../dist/index.js';

const guard = (name: string, extra: Partial<GraphNode> = {}) =>
  ({ id: 'r::a.ts::' + name, kind: 'guard', name, ...extra }) as GraphNode;

test('identity checks are tier policy; integrity checks are tier business', () => {
  assert.equal(TIER_OF_CLASS.identity, 'policy');
  assert.equal(TIER_OF_CLASS.integrity, 'business');
  assert.equal(TIER_OF_CLASS.authorisation, 'business');
  // the reference app's shapes, by their words
  assert.deepEqual(gateTierOf(guard('requireOpsSession: ops session')), {
    tier: 'policy',
    class: 'identity',
    tierFrom: 'class',
  });
  assert.deepEqual(gateTierOf(guard('requireContractorSession: signed-in contractor')), {
    tier: 'policy',
    class: 'identity',
    tierFrom: 'class',
  });
  assert.deepEqual(gateTierOf(guard('approveFourEyes: four-eyes approval')), {
    tier: 'business',
    class: 'integrity',
    tierFrom: 'class',
  });
  assert.deepEqual(gateTierOf(guard('ocrVendorNameAgrees: ocr vendor-name agreement')), {
    tier: 'business',
    class: 'integrity',
    tierFrom: 'class',
  });
  assert.deepEqual(gateTierOf(guard('rejectDuplicateInvoice: duplicate invoice number')), {
    tier: 'business',
    class: 'integrity',
    tierFrom: 'class',
  });
});

test('a precondition’s stored tier is the class’s copy, never an override; a team’s tier always is', () => {
  const pre = guard('approve: four-eyes', {
    kind: 'rule',
    precondition: { class: 'integrity', tier: 'policy' } as GraphNode['precondition'],
  });
  assert.equal(gateTierOf(pre).tier, 'business', 'a graph ingested before the move reads the new tier');
  const set = guard('requireSession: signed in', { gateTier: { tier: 'business', from: 'config' } });
  assert.deepEqual(gateTierOf(set), { tier: 'business', class: 'identity', tierFrom: 'config' });
});
