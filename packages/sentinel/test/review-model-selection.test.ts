// Selection controls use genuine effective-policy snapshots but never contact a provider or read a credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, effectivePolicy, parseSettings } from '../dist/policy/index.js';
import { bindProvider } from '../dist/review/providers/profile.js';
import { providerCaller } from '../dist/review/caller.js';
import { resolveReviewModel } from '../dist/review/providers/selection.js';
import { trustedPolicy, D } from './provider-helpers.ts';

const defaults = () => ({ stages: [
  { stage: 'guided', providerId: 'local-review', modelId: 'review' },
  { stage: 'general', providerId: 'local-openai', modelId: 'review' },
], segments: [] });
function configured(reviewModels: unknown = defaults(), over: Record<string, unknown> = {}) {
  const settings = { ...structuredClone(trustedPolicy().settings), reviewModels, ...over };
  return effectivePolicy({ trust: 'adopted', settings: settings as any, settingsDigest: D(JSON.stringify(settings)), repoConfig: null, repoConfigDigest: null });
}
const is = (code: string) => (e: any) => e?.code === code;

test('deterministic stages report model not applicable without configured model data', () => {
  assert.deepEqual(resolveReviewModel(trustedPolicy(), 'deterministic'), { stage: 'deterministic', model: 'not-applicable' });
  assert.deepEqual(resolveReviewModel(configured(null), 'deterministic'), { stage: 'deterministic', model: 'not-applicable' });
});

test('stage defaults choose exact existing provider/model bindings and make no call or admission', () => {
  const policy = configured(defaults(), { grants: [] });
  const guided = resolveReviewModel(policy, 'guided', 'segment-a');
  const general = resolveReviewModel(policy, 'general', 'segment-a');
  assert.equal(guided.selection.providerId, 'local-review');
  assert.equal(general.selection.providerId, 'local-openai');
  assert.equal(guided.selection.modelId, 'review');
  assert.equal(guided.binding.digest, bindProvider(policy, 'local-review', 'review').digest);
  assert.equal(guided.selection.bindingDigest, guided.binding.digest);
  assert.equal(guided.selectedBy, 'stage');
  assert.ok(Object.isFrozen(guided) && Object.isFrozen(guided.selection));
});

test('an exact segment override affects only its named agentic stage and segment', () => {
  const config = defaults();
  (config.segments as any[]).push({ stage: 'guided', segmentId: 'segment-a', providerId: 'local-openai', modelId: 'review' });
  const policy = configured(config);
  assert.equal(resolveReviewModel(policy, 'guided', 'segment-a').selectedBy, 'segment');
  assert.equal(resolveReviewModel(policy, 'guided', 'segment-a').selection.providerId, 'local-openai');
  assert.equal(resolveReviewModel(policy, 'guided', 'segment-b').selection.providerId, 'local-review');
  assert.equal(resolveReviewModel(policy, 'general', 'segment-a').selectedBy, 'stage');
});

test('policy, model choice, stage and segment differences change the prepared selection digest', () => {
  const first = configured(), a = resolveReviewModel(first, 'guided', 'segment-a');
  assert.notEqual(a.digest, resolveReviewModel(first, 'guided', 'segment-b').digest);
  assert.notEqual(a.digest, resolveReviewModel(first, 'general', 'segment-a').digest);
  const config = defaults(); config.stages[0]!.providerId = 'local-openai';
  assert.notEqual(a.digest, resolveReviewModel(configured(config), 'guided', 'segment-a').digest);
  assert.notEqual(a.digest, resolveReviewModel(configured(defaults(), { grants: [] }), 'guided', 'segment-a').digest);
});

test('caller audit selection is sampled from its genuine current binding and cannot rehydrate one', () => {
  const policy = configured(); let current: any = bindProvider(policy, 'local-review', 'review');
  const caller = providerCaller(undefined as any, undefined as any, () => current);
  const before = caller.selection;
  assert.equal(before.bindingDigest, current.digest); assert.ok(Object.isFrozen(before));
  current = bindProvider(policy, 'local-openai', 'review');
  assert.notEqual(caller.selection.bindingDigest, before.bindingDigest);
  current = { ...current };
  assert.throws(() => caller.selection, is('sentinel.provider.notTrusted'));
});

test('absent owner selection stays unavailable and an untrusted settings request cannot select a model', () => {
  assert.throws(() => resolveReviewModel(trustedPolicy(), 'guided', 'segment-a'), is('sentinel.provider.capabilityUntested'));
  const p = configured();
  assert.throws(() => resolveReviewModel({ ...p }, 'guided', 'segment-a'), is('sentinel.provider.notTrusted'));
  const untrusted = effectivePolicy({ trust: 'not-adopted', settings: p.settings, settingsDigest: D('untrusted'), repoConfig: null, repoConfigDigest: null });
  assert.throws(() => resolveReviewModel(untrusted, 'guided', 'segment-a'), is('sentinel.provider.capabilityUntested'));
});

test('missing models and stages refuse without widening to another configured provider', () => {
  const config = defaults(); config.stages = config.stages.filter(x => x.stage !== 'general');
  assert.throws(() => resolveReviewModel(configured(config), 'general', 'segment-a'), is('sentinel.provider.capabilityMissing'));
  config.stages[0]!.modelId = 'missing-model';
  assert.throws(() => resolveReviewModel(configured(config), 'guided', 'segment-a'), is('sentinel.provider.notTrusted'));
});

test('duplicate, unknown-key and malformed selections refuse rather than silently shadow', () => {
  const a = defaults(); a.stages[1]!.stage = 'guided';
  const b = defaults(); (b.segments as any[]).push({ stage: 'guided', segmentId: 'same', providerId: 'local-review', modelId: 'review' }, { stage: 'guided', segmentId: 'same', providerId: 'local-openai', modelId: 'review' });
  for (const config of [a, b, null, { ...defaults(), extra: true }, { ...defaults(), stages: [{ stage: 'guided', modelId: 'review' }] }, { ...defaults(), stages: [{ ...defaults().stages[0], command: 'anything' }] }]) {
    assert.throws(() => resolveReviewModel(configured(config), 'guided', 'segment-a'), is('sentinel.provider.invalidProfile'));
  }
  for (const id of ['../source', '*', '', 'a'.repeat(129)]) assert.throws(() => resolveReviewModel(configured(), 'guided', id), is('sentinel.provider.invalidProfile'));
});

test('selection cardinality and identifier bounds are enforced before resolution', () => {
  assert.throws(() => resolveReviewModel(configured({ stages: Array(3).fill(defaults().stages[0]), segments: [] }), 'guided', 'segment-a'), is('sentinel.provider.invalidProfile'));
  assert.throws(() => resolveReviewModel(configured({ stages: [], segments: Array(10001).fill({}) }), 'guided', 'segment-a'), is('sentinel.provider.invalidProfile'));
  const config = defaults(); (config.segments as any[]).push({ stage: 'guided', segmentId: '../source', providerId: 'local-review', modelId: 'review' });
  assert.throws(() => resolveReviewModel(configured(config), 'guided', 'segment-a'), is('sentinel.provider.invalidProfile'));
});

test('additive settings parsing retains absent legacy bytes and accepts only the closed selection shape', () => {
  const legacy = structuredClone(DEFAULT_SETTINGS);
  const encoded = Buffer.from(JSON.stringify(legacy));
  assert.deepEqual(parseSettings(encoded), legacy);
  assert.equal(JSON.stringify(parseSettings(encoded)), encoded.toString());
  const settings = { ...legacy, reviewModels: defaults() };
  for(const nativeClaudeReviewEnabled of [false,true])assert.equal(parseSettings(Buffer.from(JSON.stringify({...settings,nativeClaudeReviewEnabled}))).nativeClaudeReviewEnabled,nativeClaudeReviewEnabled);
  for(const nativeClaudeReviewEnabled of ['true',null,1])assert.throws(()=>parseSettings(Buffer.from(JSON.stringify({...settings,nativeClaudeReviewEnabled}))),is('sentinel.policy.settingsInvalid'));
  assert.deepEqual(parseSettings(Buffer.from(JSON.stringify(settings))).reviewModels, defaults());
  assert.throws(() => parseSettings(Buffer.from(JSON.stringify({ ...settings, reviewModels: { ...defaults(), command: 'copilot' } }))), is('sentinel.policy.settingsInvalid'));
});

// This is a deterministic dispatch refusal control; it never contacts the synthetic hosted origin.
test('public hosted review defaults to paused, requires adopted enablement and never substitutes another model', () => {
  const config = defaults(); config.stages[0]!.providerId = 'hosted-review';
  assert.throws(() => resolveReviewModel(configured(config), 'guided', 'segment-a'), is('sentinel.provider.featureDisabled'));
  assert.throws(() => resolveReviewModel(configured(config, { hostedApiReviewEnabled: false }), 'guided', 'segment-a'), is('sentinel.provider.featureDisabled'));
  const enabled = configured(config, { hostedApiReviewEnabled: true });
  assert.equal(resolveReviewModel(enabled, 'guided', 'segment-a').selection.providerId, 'hosted-review');
  // Direct existing library binding stays compatible; the public stage resolver is the added gate.
  assert.equal(bindProvider(configured(config), 'hosted-review', 'review').providerId, 'hosted-review');
  const unadopted = effectivePolicy({ trust: 'not-adopted', settings: enabled.settings, settingsDigest: D('requested-enabled'), repoConfig: null, repoConfigDigest: null });
  assert.throws(() => resolveReviewModel(unadopted, 'guided', 'segment-a'), is('sentinel.provider.capabilityUntested'));
});


test('resolver uses the same 128 character id bound as the settings contract', () => {
  const segmentId = 'segment:'.repeat(16); // 128 contract-valid characters, not a credential-shaped token.
  const config = defaults(); (config.segments as any[]).push({ stage: 'guided', segmentId, providerId: 'local-review', modelId: 'review' });
  assert.equal(resolveReviewModel(configured(config), 'guided', segmentId).segmentId, segmentId);
  const parsed = parseSettings(Buffer.from(JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), reviewModels: config })));
  assert.equal(parsed.reviewModels!.segments[0]!.segmentId, segmentId);
  assert.throws(() => resolveReviewModel(configured(config), 'guided', segmentId + 'a'), is('sentinel.provider.invalidProfile'));
});

test('hosted segment overrides remain paused under a local default without widening the local pause', () => {
  const config = defaults();
  (config.segments as any[]).push({ stage: 'guided', segmentId: 'remote-segment', providerId: 'hosted-review', modelId: 'review' });
  const policy = configured(config);
  assert.throws(() => resolveReviewModel(policy, 'guided', 'remote-segment'), is('sentinel.provider.featureDisabled'));
  assert.equal(resolveReviewModel(policy, 'guided', 'local-segment').selection.providerId, 'local-review');
});

test('segment-only selections resolve exactly their named segment with no stage fallback', () => {
  const policy = configured({ stages: [], segments: [{ stage: 'guided', segmentId: 'only-segment', providerId: 'local-review', modelId: 'review' }] });
  assert.equal(resolveReviewModel(policy, 'guided', 'only-segment').selectedBy, 'segment');
  assert.throws(() => resolveReviewModel(policy, 'guided', 'other-segment'), is('sentinel.provider.capabilityMissing'));
  assert.throws(() => resolveReviewModel(policy, 'general', 'only-segment'), is('sentinel.provider.capabilityMissing'));
});
