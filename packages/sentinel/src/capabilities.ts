// Draft contracts, store, capture, parser reconciliation, trusted policy and planning exist.
// Scanner execution remains unavailable with its reason, so a plan or store
// is never presented as completed scan coverage.

export type CapabilityState = 'available-draft' | 'unavailable';

export interface Capability {
  id: string;
  state: CapabilityState;
  reasonCode: string;
  /** The planning PR that is to deliver it (docs/proposals/farsight-sentinel/implementation-prs.md). */
  plannedIn: string;
}

const NOT_BUILT = 'sentinel.capability.notImplemented';

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  { id: 'contract-validation', state: 'available-draft', reasonCode: 'sentinel.capability.draftContracts', plannedIn: 'PR 02' },
  { id: 'ledger', state: 'available-draft', reasonCode: 'sentinel.capability.draftStore', plannedIn: 'PR 03' },
  { id: 'source-capture', state: 'available-draft', reasonCode: 'sentinel.capability.draftCapture', plannedIn: 'PR 04' },
  { id: 'parser-reconciliation', state: 'available-draft', reasonCode: 'sentinel.capability.draftParser', plannedIn: 'PR 05' },
  { id: 'trusted-policy', state: 'available-draft', reasonCode: 'sentinel.capability.draftPolicy', plannedIn: 'PR 06' },
  { id: 'rules-and-planning', state: 'available-draft', reasonCode: 'sentinel.capability.draftPlanning', plannedIn: 'PR 06' },
  { id: 'worker-isolation', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 07' },
  { id: 'coordinator', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 08' },
  { id: 'scan-cli', state: 'available-draft', reasonCode: 'sentinel.capability.draftPreviewCli', plannedIn: 'PR 09' },
  { id: 'pattern-scan', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 10' },
  { id: 'secrets-scan', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 11' },
  { id: 'dependency-advisories', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 12' },
  { id: 'infrastructure-ci-checks', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 13' },
  { id: 'framework-next', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 14' },
  { id: 'framework-express', state: 'available-draft', reasonCode: 'sentinel.capability.draftExpress', plannedIn: 'PR 15' },
  { id: 'framework-nest', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 16' },
  { id: 'framework-spring', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 17' },
  // PR 01 rejected the evaluated cross-file profiles; no deep engine is promised.
  { id: 'interprocedural-flow', state: 'unavailable', reasonCode: 'sentinel.capability.noQualifiedEngine', plannedIn: 'PR 18' },
  { id: 'reports', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 19' },
  { id: 'dispositions', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 20' },
  { id: 'model-review', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 21–22' },
  { id: 'mcp', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 23a' },
  { id: 'farsight-host-bridge', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 24' },
  { id: 'gui', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 25' },
  { id: 'replay-bundles', state: 'unavailable', reasonCode: NOT_BUILT, plannedIn: 'PR 26' },
].map(c => Object.freeze(c as Capability)));

export function capability(id: string): Capability | undefined {
  return CAPABILITIES.find(c => c.id === id);
}
