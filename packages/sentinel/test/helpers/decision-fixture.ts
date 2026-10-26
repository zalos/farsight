import { canonicalDigest } from '../../dist/policy/digest.js';
import { effectivePolicy, DEFAULT_SETTINGS } from '../../dist/policy/settings.js';
export const D = (s: unknown) => canonicalDigest(s);
export const NOW = new Date('2026-10-22T12:00:00.000Z');
export const WORKSPACE = D('workspace');
export const policy = (grant = true) =>
  effectivePolicy({
    trust: 'adopted',
    settings: {
      ...DEFAULT_SETTINGS,
      grants: grant ? [{ actions: ['disposition.approve'], principals: ['human'], confirm: 'never' }] : [],
    },
    settingsDigest: D(grant),
    repoConfig: null,
    repoConfigDigest: null,
  });
export const basis = {
  findingId: 'finding-cookie',
  findingFingerprint: D('cookie'),
  snapshotId: 'snapshot-1',
  sourceId: 'app',
  environmentDigest: D('environment'),
  deploymentDigest: D('deployment'),
  paths: ['GET /orders', 'POST /orders'].map((route) => ({
    surfaceId: `app::route::${route}`,
    routeDigest: D(route),
    controlDigest: D('control'),
    resolutionDigest: D('resolution'),
    frameworkDigest: D('framework'),
    resolution: 'exact' as const,
  })),
};
export const input = {
  decision: 'accepted-risk' as const,
  rationale: 'Owner accepts the scoped residual risk.',
  surfaceIds: basis.paths.map((p) => p.surfaceId),
  evidence: [D('evidence')],
  expiresAt: '2026-10-23T12:00:00.000000000Z',
  supersedes: null,
};
export const actor = { channel: 'model' as const, principal: 'proposed owner name grants no authority' };
