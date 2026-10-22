// Correlating observations into findings within one run (PR 19, ADR 38). Observations from different producers, or
// from different versions of one producer, that make the same claim — the same rule family over the same anchor set —
// become one finding that keeps every observation id. Observations that share only a sink, or only a symbol, stay
// separate findings: distinct weaknesses are never collapsed.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';
import type { Digest } from '../contracts/index.js';
import { SEVERITIES, type Anchor, type NormalizedObservation, type Severity } from './normalize.js';

export const FINGERPRINT_VERSION = 'sentinel-issue/1';

export interface Finding {
  readonly id: string;
  readonly ruleFamilyId: string;
  readonly severity: Severity;
  readonly fingerprint: { readonly version: string; readonly exact: Digest; readonly probable: Digest };
  /** Sorted, unique. */
  readonly observationIds: readonly string[];
  readonly observations: readonly NormalizedObservation[];
  /** The anchors of the finding (equal across its observations by construction). */
  readonly anchors: readonly Anchor[];
  readonly secret: boolean;
  /** The canonical graph symbols the finding is anchored in. */
  readonly nodeIds: readonly string[];
  readonly sourceIds: readonly string[];
}

const digest = (v: unknown): Digest => `sha256:${createHash('sha256').update(canonicalJson(v)).digest('hex')}`;
const symbolOf = (a: Anchor) => a.nodeId ?? (a.withheld ? `${a.sourceId}::withheld::${a.content}` : `${a.sourceId}::file::${a.relativePath}`);

/** The two keys issue identity is built from. Neither contains a line number or a byte offset. */
export function fingerprintOf(sourceIds: readonly string[], ruleFamilyId: string, anchors: readonly Anchor[], secret = false) {
  // A secret claim and an ordinary claim over the same anchors are different findings with different identities.
  const exact = digest({
    v: FINGERPRINT_VERSION, sources: [...new Set(sourceIds)].sort(), rule: ruleFamilyId, secret,
    anchors: anchors.map(a => [a.role, symbolOf(a), a.textDigest]).sort((x, y) => (canonicalJson(x) < canonicalJson(y) ? -1 : 1)),
  });
  const probable = digest({
    v: FINGERPRINT_VERSION, sources: [...new Set(sourceIds)].sort(), rule: ruleFamilyId, secret,
    symbols: [...new Set(anchors.map(a => `${a.role}\u0000${symbolOf(a)}`))].sort(),
  });
  return { version: FINGERPRINT_VERSION, exact, probable };
}

export function correlate(observations: readonly NormalizedObservation[]): Finding[] {
  const groups = new Map<string, NormalizedObservation[]>();
  const fingerprints = new Map<string, ReturnType<typeof fingerprintOf>>();
  for (const o of observations) {
    const sources = o.anchors.map(a => a.sourceId);
    // Secret and non-secret claims are never merged, and never share an id: disclosure follows the finding.
    const fp = fingerprintOf(sources, o.ruleFamilyId, o.anchors, o.secret);
    const key = fp.exact;
    groups.set(key, [...groups.get(key) ?? [], o]);
    fingerprints.set(key, fp);
  }
  const out: Finding[] = [];
  for (const [key, group] of groups) {
    const fp = fingerprints.get(key)!;
    const first = [...group].sort((a, b) => (a.observationId < b.observationId ? -1 : 1))[0]!;
    const severity = SEVERITIES.find(s => group.some(o => o.severity === s))!;
    const nodeIds = [...new Set(first.anchors.map(a => a.nodeId).filter((n): n is string => !!n))].sort();
    out.push({
      id: `finding.${fp.exact.slice(7, 47)}`, ruleFamilyId: first.ruleFamilyId, severity, fingerprint: fp,
      observationIds: [...new Set(group.map(o => o.observationId))].sort(), observations: group, anchors: first.anchors,
      secret: first.secret, nodeIds, sourceIds: [...new Set(first.anchors.map(a => a.sourceId))].sort(),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
