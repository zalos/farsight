// The provider-backed model caller (PR 22 over PR 21): one session operation is one `ModelBroker.generate` call under
// an admitted envelope, with the operation id as the budget ledger's operation id, so a settled or uncertain
// operation is never sent again. The current binding is passed on every call; a changed provider or policy stops it.
import type { ModelIdentity } from '../contracts/index.js';
import type { ModelBroker, ModelEnvelope } from './providers/broker.js';
import { isProviderBinding, type ProviderBinding, type ProviderSelection } from './providers/profile.js';
import { fail } from './providers/errors.js';
import { cliKind } from './providers/registry.js';
import { canonicalDigest } from '../policy/digest.js';
import type { NativeReviewWire } from '../contracts/instructions.js';
import type { CallerReply, ModelCaller } from './session.js';

export function providerCaller(
  broker: ModelBroker,
  envelope: ModelEnvelope,
  binding: () => ProviderBinding,
  options?: Readonly<{ deadlineAt: number }>,
): ModelCaller & { readonly selection: ProviderSelection } {
  return {
    kind: 'provider',
    get selection(): ProviderSelection {
      const current = binding();
      if (!isProviderBinding(current))
        fail('sentinel.provider.notTrusted', 'selection requires the current genuine provider binding');
      return Object.freeze({ providerId: current.providerId, modelId: current.modelId, bindingDigest: current.digest });
    },
    renderRequest(messages, maxOutputTokens) {
      const current = binding();
      if (!isProviderBinding(current))
        fail('sentinel.provider.notTrusted', 'native rendering requires the current genuine binding');
      const render = (
        broker as ModelBroker & {
          renderRequest?: (b: ProviderBinding, m: typeof messages, n: number) => NativeReviewWire | undefined;
        }
      ).renderRequest;
      return render?.call(broker, current, messages, maxOutputTokens);
    },
    async call(req): Promise<CallerReply> {
      const current = binding();
      if (!isProviderBinding(current))
        fail('sentinel.provider.notTrusted', 'a call requires the current genuine binding');
      if (
        req.requestedSelection &&
        canonicalDigest(req.requestedSelection) !==
          canonicalDigest({ providerId: current.providerId, modelId: current.modelId, bindingDigest: current.digest })
      )
        fail('sentinel.provider.bindingChanged', 'the requested selection changed before dispatch');
      // Compare and dispatch this exact immutable binding; no second getter can substitute another model.
      const r = await broker.generate(envelope, current, {
        operationId: req.operationId,
        messages: req.messages,
        maxOutputTokens: req.maxOutputTokens,
        ...(options
          ? {
              deadlineAt: cliKind(current.kind)?.capsTurnDeadline
                ? Math.min(options.deadlineAt, Date.now() + current.limits.timeoutMs)
                : options.deadlineAt,
            }
          : {}),
        ...(req.expectedWireDigest ? { expectedWireDigest: req.expectedWireDigest } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      const identity: ModelIdentity = {
        requestedModel: r.identity.requestedModel,
        returnedModel: r.identity.returnedModel,
        immutableRevision: r.identity.probedRevision,
        source: r.identity.source,
      };
      return {
        content: r.content,
        truncated: r.truncated,
        identity,
        usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
      };
    },
  };
}
