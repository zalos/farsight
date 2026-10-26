// No real native credential or model request. Settings/admission/wire refusals are checked before dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, effectivePolicy, admit, ReceiptBook } from '../dist/policy/index.js';
import { BudgetLedger, ModelBroker, bindProvider, envelopeIntent } from '../dist/review/providers/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { nativeClaudeCall } from '../dist/review/providers/cli-native-call.js';
import { readNativeLogin } from '../dist/review/providers/cli-native-helper.js';
import { assertNativeClaudeReviewEnabled, resolveReviewModel } from '../dist/review/providers/selection.js';
import { CLAUDE_NATIVE_PROFILE } from '../dist/review/providers/cli-native-profile.js';
import { D, NOW, TERMS, LIMITS, scratchDir } from './provider-helpers.ts';
const model = 'claude-haiku-4-5-20251001';
const budget = { maxTokens: 200000, maxCost: null, currency: null };
const profile = {
  id: CLAUDE_NATIVE_PROFILE.id,
  executableDigest: CLAUDE_NATIVE_PROFILE.executableDigest,
  helperDigest: D('synthetic-helper'),
  profileDigest: D('synthetic-profile'),
};
function policy(over: Record<string, unknown> = {}, modelOver: Record<string, unknown> = {}) {
  return effectivePolicy({
    trust: 'adopted',
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      nativeClaudeReviewEnabled: true,
      grants: [
        { actions: ['paid.admit'], principals: ['human'], confirm: 'never', scope: { providers: ['native-claude'] } },
      ],
      reviewModels: { stages: [{ stage: 'guided', providerId: 'native-claude', modelId: 'haiku' }], segments: [] },
      providers: [
        {
          id: 'native-claude',
          kind: 'claude-cli',
          endpoint: 'https://api.anthropic.com',
          credential: null,
          disclosure: 'hosted',
          nativeProfile: profile,
          budget,
          models: [
            {
              id: 'haiku',
              model,
              limits: { ...LIMITS, contextTokens: 200000 },
              pricing: { kind: 'subscription-quota', basis: 'owner-subscription' },
              terms: TERMS,
              capability: {
                schema: 'sentinel-model-capability/draft-1',
                kind: 'claude-cli',
                origin: 'https://api.anthropic.com',
                model,
                listed: true,
                revision: null,
                probedAt: '2026-10-22T11:00:00.000000000Z',
              },
              ...modelOver,
            },
          ],
          ...over,
        },
      ],
    } as any,
    settingsDigest: D(JSON.stringify([over, modelOver])),
    repoConfig: null,
    repoConfigDigest: null,
  });
}
const code = (c: string) => (e: any) => e?.code === c;
test('explicitly enabled owner-adopted native CLI resolves while hosted API flag is absent; deterministic remains not applicable', () => {
  const p = policy(),
    r = resolveReviewModel(p, 'guided', 'segment-1');
  assert.equal(r.binding.kind, 'claude-cli');
  assert.equal(r.binding.model, model);
  assert.equal(r.binding.pricing.kind, 'subscription-quota');
  assert.deepEqual(resolveReviewModel(p, 'deterministic'), { stage: 'deterministic', model: 'not-applicable' });
  assert.throws(
    () => bindProvider(policy({ nativeProfile: null }), 'native-claude', 'haiku'),
    code('sentinel.provider.invalidProfile'),
  );
});
test('native subscription cannot adopt alternate endpoint, credential, native identity, model, monetary basis or expanded fixed context', () => {
  for (const [p, m] of [
    [{ endpoint: 'https://other.example' }, {}],
    [{ credential: 'keychain:farsight/example' }, {}],
    [{ budget: { ...budget, maxCost: '0', currency: 'USD' } }, {}],
    [{ nativeProfile: { ...profile, id: 'unreviewed' } }, {}],
    [{}, { model: 'claude-opus-other' }],
    [{}, { pricing: { kind: 'no-fee', basis: 'local-runtime' } }],
    [{}, { limits: { ...LIMITS, contextTokens: 200001 } }],
  ] as any)
    assert.throws(
      () => bindProvider(policy(p, m), 'native-claude', 'haiku'),
      (e: any) => e.code?.startsWith('sentinel.provider.'),
    );
});
test('shared admission honors only explicit bounded native quota; no null-money monetary bypass or uncapped tokens', () => {
  const p = policy(),
    binding = bindProvider(p, 'native-claude', 'haiku');
  const decide = (b: any) =>
    admit({
      policy: p,
      intent: envelopeIntent(binding, 'run-1', b),
      requestedBy: { principal: 'human', channel: 'owner-cli' },
      stateDigest: D('state'),
      now: NOW,
      capability: () => ({ available: true, detail: 'synthetic qualification' }),
      credential: () => ({ basis: 'keychain-scope', allowed: true, detail: 'synthetic capability' }),
    });
  assert.equal(decide(budget).record.verdicts.policy.allowed, true);
  assert.equal(decide({ ...budget, maxTokens: 200001 }).record.verdicts.policy.allowed, false);
  assert.equal(decide({ ...budget, maxTokens: null }).record.verdicts.policy.allowed, false);
  assert.equal(decide({ ...budget, maxCost: '0', currency: 'USD' }).record.verdicts.policy.allowed, false);
});
test('missing or forged native runtime refuses before receipt consumption, ledger envelope or credential access', async (t) => {
  const ledger = await BudgetLedger.open(join(scratchDir(t), 'budget.db'));
  t.after(() => ledger.close());
  let reads = 0;
  const p = policy(),
    binding = bindProvider(p, 'native-claude', 'haiku');
  const base = {
    binding,
    policy: p,
    runId: 'run-1',
    budget,
    requestedBy: { principal: 'human' as const, channel: 'owner-cli' as const },
    stateDigest: D('state'),
  };
  const broker = new ModelBroker({
    ledger,
    credentials: async () => {
      reads++;
      throw Error();
    },
    epoch: 'e',
    now: () => NOW,
  });
  await assert.rejects(broker.openEnvelope(base), code('sentinel.provider.receiptRequired'));
  const forged = new ModelBroker({
    ledger,
    credentials: async () => {
      reads++;
      throw Error();
    },
    epoch: 'e',
    now: () => NOW,
    nativeClaude: {
      profileId: profile.id,
      executableDigest: profile.executableDigest,
      helperDigest: profile.helperDigest,
      profileDigest: profile.profileDigest,
    } as any,
  });
  const book = new ReceiptBook(join(scratchDir(t), 'receipts'));
  const receipt = issueReceipt(
    book,
    { channel: 'owner-cli', principal: 'owner' },
    { intent: envelopeIntent(binding, 'run-1', budget), stateDigest: base.stateDigest, policyRevision: p.revision },
    { now: NOW, ttlMs: 60000 },
  );
  await assert.rejects(
    forged.openEnvelope({ ...base, receipt: { book, id: receipt.id } }),
    code('sentinel.provider.notTrusted'),
  );
  assert.equal(reads, 0);
  assert.deepEqual(ledger.listEnvelopes({ limit: 5 }), []);
});
test('native exact wire is audit data only, bounded and changed by model/input/output; context quota includes opaque vendor overhead', () => {
  const p = policy(),
    binding = bindProvider(p, 'native-claude', 'haiku'),
    broker = new ModelBroker({
      ledger: {} as any,
      credentials: async () => {
        throw Error();
      },
      epoch: 'e',
    });
  const messages = [
    { role: 'system', content: 'exact selected instructions' },
    { role: 'user', content: 'tiny source' },
  ] as const;
  const wire = broker.renderRequest(binding, messages, 64)!;
  assert.equal(wire.requestedModel, model);
  assert.equal(wire.system, messages[0].content);
  assert.notEqual(JSON.stringify(wire), JSON.stringify(broker.renderRequest(binding, messages, 65)));
  assert.deepEqual(broker.worstCase(binding, Buffer.from(wire.stdin), 2, 64), {
    inputTokens: 199936,
    tokens: 200000,
    costNanos: null,
  });
  assert.throws(
    () =>
      broker.renderRequest(
        binding,
        [
          { role: 'system', content: 'x'.repeat(65536) },
          { role: 'user', content: 'y' },
        ],
        64,
      ),
    code('sentinel.provider.requestTooLarge'),
  );
});

test('a structural call or runtime value cannot acquire native launch or keychain authority', async () => {
  const runtime = {
    profileId: profile.id,
    executableDigest: profile.executableDigest,
    helperDigest: profile.helperDigest,
    profileDigest: profile.profileDigest,
  };
  for (const value of [runtime, { nativeCall: 'closed-v1' }, {}]) {
    await assert.rejects(nativeClaudeCall(value as any), code('sentinel.provider.notAdmitted'));
    await assert.rejects(
      readNativeLogin(
        { digest: profile.helperDigest, protocol: 'claude-keychain-token/1' },
        { deadlineAt: Date.now() + 1000 },
        value as any,
      ),
      code('sentinel.provider.notAdmitted'),
    );
  }
});

test('published settings schema keeps provider kinds and accounting bases as explicit closed literal sets', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../schemas/sentinel-settings.draft-1.schema.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(schema.definitions.ProviderSettings.properties.kind.enum, [
    'ollama',
    'openai-compatible',
    'claude-cli',
    'copilot-cli',
  ]);
  assert.deepEqual(schema.definitions.ModelCapability.properties.kind.enum, [
    'ollama',
    'openai-compatible',
    'claude-cli',
    'copilot-cli',
  ]);
  assert.deepEqual(schema.definitions.ModelPricing.properties.kind.enum, ['rates', 'no-fee', 'subscription-quota']);
});

// No credential, receipt or process is needed to evaluate the release flag.
test('public native Claude defaults off for stage/segment choices and opt-in never enables another provider', () => {
  const opted = policy();
  for (const flag of [undefined, false]) {
    const settings = { ...structuredClone(opted.settings) };
    if (flag === undefined) delete settings.nativeClaudeReviewEnabled;
    else settings.nativeClaudeReviewEnabled = flag;
    const p = effectivePolicy({
      trust: 'adopted',
      settings,
      settingsDigest: D(JSON.stringify(settings)),
      repoConfig: null,
      repoConfigDigest: null,
    });
    assert.throws(() => resolveReviewModel(p, 'guided', 'segment-1'), code('sentinel.provider.nativeClaudeDisabled'));
    assert.throws(
      () => assertNativeClaudeReviewEnabled(p, 'native-claude'),
      code('sentinel.provider.nativeClaudeDisabled'),
    );
    assert.deepEqual(resolveReviewModel(p, 'deterministic'), { stage: 'deterministic', model: 'not-applicable' });
    assert.equal(
      bindProvider(p, 'native-claude', 'haiku').kind,
      'claude-cli',
      'retained implementation is not deleted',
    );
  }
  assert.equal(resolveReviewModel(opted, 'guided', 'segment-1').binding.kind, 'claude-cli');
  assert.throws(
    () => assertNativeClaudeReviewEnabled({ ...opted } as any, 'native-claude'),
    code('sentinel.provider.notTrusted'),
  );
});
