// Finding identity and full-run comparison (PR 19, ADR 38): normalize observations, correlate them into findings,
// match findings across runs (exact, probable, ambiguous) and label two complete assessments.
export { normalizeObservation, isSecretObservation, SEVERITIES } from './normalize.js';
export type { Anchor, AnchorRole, NormalizedObservation, Severity } from './normalize.js';
export { correlate, fingerprintOf, FINGERPRINT_VERSION } from './correlate.js';
export type { Finding } from './correlate.js';
export { matchFindings, MatchError } from './match.js';
export type { MatchableFinding, MatchResult } from './match.js';
export { compareAssessments } from './compare.js';
export type {
  AssessmentSide,
  CheckAssessment,
  Comparison,
  ComparisonRequest,
  CompatibilityMapping,
  CurrentLabel,
  CurrentOutcome,
  CurrentSurfaces,
  DetectionConditions,
  HistoricalLabel,
  HistoricalOutcome,
} from './compare.js';

// Scoped decisions: only proposals/read models are public. Approval stays in the package's owner CLI boundary.
export { DecisionJournal } from './dispositions.js';
export type { DecisionProposal, ApprovedDecision, DecisionApprovalOutcome } from './dispositions.js';
export { DecisionError } from './decision-data.js';
export type { DecisionBasis, DecisionPathBasis, DecisionProposalInput } from './decision-data.js';
export { ASSERTION_PROPERTIES } from './assertions.js';
export type { DeploymentAssertion, AssertionProperty, AssertionDirection } from './assertions.js';
export { evaluateDecisions } from './decision-evaluation.js';
export type { DecisionEvaluation, EvaluatedDecisionPath, DecisionPathReason } from './decision-evaluation.js';
