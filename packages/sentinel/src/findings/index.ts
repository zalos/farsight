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
  AssessmentSide, CheckAssessment, Comparison, ComparisonRequest, CompatibilityMapping, CurrentLabel, CurrentOutcome, CurrentSurfaces,
  DetectionConditions, HistoricalLabel, HistoricalOutcome,
} from './compare.js';
