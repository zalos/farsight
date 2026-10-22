// Normalizing observations (PR 19, ADR 38). An observation is one producer's immutable claim; normalizing never
// rewrites it. It derives what issue identity needs: the rule family, a severity on Sentinel's scale (the original
// kept beside it), and an anchor per evidence location. An anchor's identity is the canonical symbol the parser
// placed it in (`nodeId`) and a digest of the cited text with its whitespace collapsed, so moving code up or down a
// file does not change it, while editing the cited code does. Line numbers never enter identity.
import { createHash } from 'node:crypto';
import type { ArtifactId, Digest, ObservationEnvelope, SourceEvidence } from '../contracts/index.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Where an anchor sits in the claim: the first location is the source, the last the sink, the rest steps. */
export type AnchorRole = 'source' | 'step' | 'sink' | 'single';

export interface Anchor {
  readonly role: AnchorRole;
  readonly sourceId: string;
  readonly relativePath: string;
  readonly content: ArtifactId;
  readonly span: { readonly startByte: number; readonly endByte: number };
  /** The canonical graph symbol the evidence sits in, when the producer or parser named one. */
  readonly nodeId: string | null;
  /** Digest of the cited bytes with whitespace runs collapsed: stable under line movement. */
  readonly textDigest: Digest;
  /** The evidence's own index in the observation, for citing it back. */
  readonly evidenceIndex: number;
}

export interface NormalizedObservation {
  readonly observationId: string;
  readonly snapshotId: string;
  readonly producer: string;
  readonly ruleFamilyId: string;
  /** The family's revision digest when the observation was planned under one; part of detection conditions. */
  readonly ruleRevision: Digest | null;
  readonly severity: Severity;
  readonly originalSeverity: string;
  /** Severity was not one Sentinel recognizes: recorded as information, never guessed upward. */
  readonly severityUnmapped: boolean;
  readonly anchors: readonly Anchor[];
  /** The observation concerns a secret: its evidence and location are never disclosed. */
  readonly secret: boolean;
  readonly observation: ObservationEnvelope;
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: 'critical', blocker: 'critical', high: 'high', error: 'high', major: 'high', medium: 'medium', moderate: 'medium',
  warning: 'medium', low: 'low', minor: 'low', note: 'low', info: 'info', informational: 'info', none: 'info',
};

const sha = (b: string | Uint8Array): Digest => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export const isSecretObservation = (o: ObservationEnvelope): boolean =>
  (o.rule?.familyId ?? '').startsWith('sentinel.secrets.') || o.limitationKeys.some(k => k.startsWith('sentinel.secrets.'));

function producerOf(o: ObservationEnvelope): string {
  const p = o.producer;
  return p.kind === 'imported' ? `imported:${p.provenanceArtifact}` : `${p.kind}:${p.adapterId}`;
}

/** Reads every cited span once per content and normalizes the observation. */
export async function normalizeObservation(o: ObservationEnvelope, readContent: (id: ArtifactId) => Promise<Uint8Array>,
  cache: Map<string, Promise<Uint8Array>> = new Map()): Promise<NormalizedObservation> {
  const read = (id: string) => { let p = cache.get(id); if (!p) cache.set(id, p = readContent(id)); return p; };
  const anchors: Anchor[] = [];
  const n = o.evidence.length;
  for (let i = 0; i < n; i++) {
    const e: SourceEvidence = o.evidence[i]!;
    const bytes = await read(e.content);
    const slice = Buffer.from(bytes).subarray(Math.min(e.span.startByte, bytes.length), Math.min(e.span.endByte, bytes.length));
    const text = slice.toString('utf8').replace(/\s+/g, ' ').trim();
    anchors.push({
      role: n === 1 ? 'single' : i === 0 ? 'source' : i === n - 1 ? 'sink' : 'step',
      sourceId: e.sourceId, relativePath: e.relativePath, content: e.content, span: { startByte: e.span.startByte, endByte: e.span.endByte },
      nodeId: e.nodeId ?? null, textDigest: sha(text), evidenceIndex: i,
    });
  }
  const original = o.originalSeverity;
  const mapped = SEVERITY_ALIASES[original.trim().toLowerCase()];
  const familyId = o.rule?.familyId ?? `${o.producer.kind === 'imported' ? 'imported' : o.producer.adapterId}/${o.producerRuleId}`;
  return {
    observationId: o.id, snapshotId: o.snapshotId, producer: producerOf(o), ruleFamilyId: familyId,
    ruleRevision: o.rule?.revisionDigest ?? null,
    severity: mapped ?? 'info', originalSeverity: original, severityUnmapped: !mapped,
    anchors, secret: isSecretObservation(o), observation: o,
  };
}
