// The provider-backed model caller (PR 22 over PR 21): one session operation is one `ModelBroker.generate` call under
// an admitted envelope, with the operation id as the budget ledger's operation id, so a settled or uncertain
// operation is never sent again. The current binding is passed on every call; a changed provider or policy stops it.
import type { ModelIdentity } from '../contracts/index.js';
import type { ModelBroker, ModelEnvelope } from './providers/broker.js';
import type { ProviderBinding } from './providers/profile.js';
import type { CallerReply, ModelCaller } from './session.js';

export function providerCaller(broker: ModelBroker, envelope: ModelEnvelope, binding: () => ProviderBinding): ModelCaller {
  return {
    kind: 'provider',
    async call(req): Promise<CallerReply> {
      const r = await broker.generate(envelope, binding(), { operationId: req.operationId, messages: req.messages, maxOutputTokens: req.maxOutputTokens,
        ...(req.signal ? { signal: req.signal } : {}) });
      const identity: ModelIdentity = { requestedModel: r.identity.requestedModel, returnedModel: r.identity.returnedModel,
        immutableRevision: r.identity.probedRevision, source: r.identity.source };
      return { content: r.content, truncated: r.truncated, identity, usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } };
    },
  };
}
