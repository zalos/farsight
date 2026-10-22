// One fixed intent and binding the receipt crash tests confirm and spend.
import { createHash } from 'node:crypto';
const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
export const NOW = new Date('2026-10-22T12:00:00.000Z');
export const binding = {
  intent: { action: 'run.cancel' as const, input: D('plan'), effects: ['local-artifacts' as const], budget: { maxTokens: null, maxCost: null, currency: null },
    scope: { profile: 'static', provider: null, targets: [] } },
  stateDigest: D('state'), policyRevision: D('policy'),
};
