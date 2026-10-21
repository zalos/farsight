import type { StringEntry } from './strings.js';
const same = (word: string, define: string): StringEntry => ({ hud: word, professional: word, define });
export const API_POLICY_STRINGS: Record<string, StringEntry> = {
  'api.policy.planned': same('planned', 'Declared operations for a delivery phase proven later than the selected phase.'),
  'api.policy.internal': same('internal', 'Implemented operations explicitly declared internal by the source configuration.'),
  'api.policy.plannedHeading': same('planned for a later phase', 'These operations are still declared without implementation; delivery policy excludes them from missing failures.'),
  'api.policy.internalDeclaration': same('internal declaration', 'This implemented operation remains absent from the contract but has an explicit internal declaration.'),
  'api.policy.raw': same('raw evidence: not implemented {missing} · undocumented {undocumented} · drift facts {drift}', 'Original reconciliation counts before applying delivery policy exclusions.'),
  'api.policy.clean': same('no policy drift — raw evidence remains in the report.', 'No selected delivery policy category contains a difference; raw operation lists remain available.'),
  'api.policy.strictError': same('api diff --strict accepts missing,undocumented,notes', 'Select one or more supported categories, separated by commas.'),
};
