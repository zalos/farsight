// Package-internal fixed crash boundaries; default off. No public, persisted, driver or report input sets this.
export type EvidencePoint = 'after-spend' | 'after-operation' | 'after-stage' | 'after-objects' | 'before-commit' | 'after-commit' | 'before-reply' | 'abandon-before-commit';
export const evidenceIo: { after: ((point: EvidencePoint) => void) | null } = { after: null };
export function evidencePoint(point: EvidencePoint): void { evidenceIo.after?.(point); }
