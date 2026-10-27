// Durable preparation is separate from run execution. These are projections/data, never receipt capabilities.
import type { CatalogKey, Digest, Id, Ordinal, Timestamp } from './common.js';
import type { ControlAdmissionVerdict } from './service.js';
import type { ReportCount } from './report.js';
export type PreparationPhase =
  | 'admitting'
  | 'resuming'
  | 'accepted'
  | 'discovering'
  | 'capturing'
  | 'captured'
  | 'bootstrapping'
  | 'prepared'
  | 'interrupted'
  | 'failed'
  | 'canceled';
/** @pattern ^prep-[a-f0-9]{32}$ */
export type PreparationId = string;
/** @pattern ^prepare-preview-[a-f0-9]{32}$ */
export type PreparationPreviewId = string;
/** @pattern ^[A-Za-z0-9_-]{16,128}$ */
export type PreparationRequestKey = string;
export interface PreparationCapabilities {
  schema: 'sentinel-preparation-capabilities/draft-1';
  apiRevision: 1;
  storeId: Id;
  epoch: Id;
  operations: ['configuration.preview', 'prepare.accept', 'prepare.status', 'prepare.resume', 'prepare.cancel'];
  preparationMs: 600000;
  previewMs: 30000;
  terminalLimit: 256;
  source: 'configured-workspace';
  prerequisites: ['capture', 'parse', 'inventory'];
  checksStartSeparately: true;
  automaticResume: false;
  limitationKey: 'sentinel.preparation.limits';
}
/** Read-only data for the actual owner CLI only. A client cannot turn this into a receipt or human authority. */
export interface PreparationConfirmation {
  intent: {
    action: 'capture.source' | 'run.cancel';
    input: Digest;
    /** @minItems 1 @maxItems 2 */
    effects: Array<'local-artifacts' | 'tool-execution'>;
    budget: { maxTokens: null; maxCost: null; currency: null };
    scope: {
      profile: 'static';
      provider: null;
      /** @minItems 1 @maxItems 1 */
      targets: Digest[];
    };
  };
  stateDigest: Digest;
  policyRevision: Digest;
}
export interface ConfigurationPreview {
  schema: 'sentinel-configuration-preview/draft-1';
  id: PreparationPreviewId;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  mode: 'workspace' | 'retry';
  /** @minItems 1 @maxItems 2 */
  effects: Array<'local-artifacts' | 'tool-execution'>;
  stages: [
    { stage: 'capture'; required: true },
    { stage: 'parse'; required: true },
    { stage: 'inventory'; required: true },
    { stage: 'check'; required: false },
  ];
  counts: { selectedRules: ReportCount; mandatoryRules: ReportCount };
  capabilitiesChecked: false;
  sourceCaptured: false;
  /** Absent from MCP. Private socket CLI data only; never a consumed receipt. */
  confirmation?: PreparationConfirmation;
}
export interface PreparationAvailability {
  adapterId: Id;
  available: boolean;
  reasonCode: CatalogKey | null;
}
export type PreparationStatus =
  | { schema: 'sentinel-preparation-status/draft-1'; found: false }
  | {
      schema: 'sentinel-preparation-status/draft-1';
      found: true;
      preparationId: PreparationId;
      phase: PreparationPhase;
      acceptedAt: Timestamp;
      deadlineAt: Timestamp;
      runDeadlineAt: Timestamp;
      captured: boolean;
      runId: Id | null;
      /** The prepared revision is historical; run.inspect reports the run's actual current revision/state. */
      preparedRevision: Ordinal | null;
      checksStartedByPreparation: false;
      /** @maxItems 32 */
      availability: PreparationAvailability[];
      reasonCode?: CatalogKey;
      resumeAvailable?: boolean;
      freshRequestRequired?: boolean;
      /** Absent from MCP. Only the real owner CLI can turn this data into confirmation. */
      confirmation?: { cancel: PreparationConfirmation; resume?: PreparationConfirmation };
    };
/** Only outcomes produced by preparation, copied from the canonical command result; never a new verdict fold. */
export type PreparationCommandOutcome =
  | 'submitted'
  | 'requested'
  | 'kept'
  | 'answered'
  | 'configuration-failure'
  | 'awaiting-confirmation'
  | 'unavailable'
  | 'refused';
export interface PreparationOutcome {
  schema: 'sentinel-preparation-outcome/draft-1';
  outcome: PreparationCommandOutcome;
  /** @asType integer @minimum 0 @maximum 4 */
  exitCode: number;
  verdicts: {
    policy: ControlAdmissionVerdict;
    capability: ControlAdmissionVerdict;
    credential: ControlAdmissionVerdict;
  };
  reasonCode?: CatalogKey;
  status: PreparationStatus | null;
  joined?: boolean;
}
