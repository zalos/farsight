// Control projections only: authorization and execution remain the existing OwnerService handlers.
import { STRINGS } from '@farsight/core/dist/strings.js';
import { OUTCOME_EXIT_CODES } from '../cli/outcome.js';
import { RUN_STATES, type ControlCapabilities, type ControlOutcome, type ControlAdmissionVerdict } from '../contracts/index.js';

export const CONTROL_OPERATIONS = Object.freeze(['run.start', 'run.pause', 'run.cancel'] as const);
const invalid = () => Object.assign(new Error('sentinel.service.controlOutcomeUnknown'), { code: 'sentinel.service.controlOutcomeUnknown' });
const catalog = (v: unknown): string => {
  if (typeof v !== 'string' || !v.startsWith('sentinel.') || !Object.hasOwn(STRINGS, v)) throw invalid();
  return v;
};
export function controlCapabilities(storeId: string, epoch: string): ControlCapabilities {
  return { schema: 'sentinel-control-capabilities/draft-1', apiRevision: 1, storeId, epoch,
    operations: [...CONTROL_OPERATIONS], resultSchema: 'sentinel-control-outcome/draft-1',
    authorization: 'adopted-agent-grant-or-owner-cli-receipt', ownerConfirmation: 'owner-cli',
    limitationKey: 'sentinel.service.controlLimits' };
}
export function controlOutcome(value: any): ControlOutcome {
  if (!value || typeof value.outcome !== 'string' || !Object.hasOwn(OUTCOME_EXIT_CODES, value.outcome)) throw invalid();
  const outcome = value.outcome as ControlOutcome['outcome'];
  if (value.exitCode !== OUTCOME_EXIT_CODES[outcome]) throw invalid();
  const verdict = (v: any): ControlAdmissionVerdict => {
    if (!v || typeof v.allowed !== 'boolean' || typeof v.asked !== 'boolean') throw invalid();
    return { allowed: v.allowed, asked: v.asked, reasonCode: catalog(v.reasonCode) };
  };
  const state = value.facts?.state;
  return { schema: 'sentinel-control-outcome/draft-1', outcome, exitCode: OUTCOME_EXIT_CODES[outcome],
    verdicts: { policy: verdict(value.verdicts?.policy), capability: verdict(value.verdicts?.capability), credential: verdict(value.verdicts?.credential) },
    ...(value.reasonCode === undefined ? {} : { reasonCode: catalog(value.reasonCode) }),
    state: typeof state === 'string' && [...RUN_STATES, 'interrupted', 'awaiting-first-execution'].includes(state as any) ? state as ControlOutcome['state'] : null,
    ...(typeof value.facts?.joined === 'boolean' ? { joined: value.facts.joined } : {}) };
}
