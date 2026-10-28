// Normalizing observations (PR 19, ADR 38). An observation is one producer's immutable claim; normalizing never
// rewrites it. It derives what issue identity needs: the rule family, a severity on Sentinel's scale (the original
// kept beside it), and an anchor per evidence location. An anchor's identity is the canonical symbol the parser
// placed it in (`nodeId`) and a digest of the cited text with its whitespace collapsed, so moving code up or down a
// file does not change it, while editing the cited code does. Line numbers never enter identity.
import { createHash } from 'node:crypto';
import type { ArtifactId, Digest, ObservationEnvelope, WithheldLocationEvidence } from '../contracts/index.js';

/** Sentinel's severity scale. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
/** The severity scale, most severe first. */
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Where an anchor sits in the claim: the first location is the source, the last the sink, the rest steps. */
export type AnchorRole = 'source' | 'step' | 'sink' | 'single';

/**
 * One evidence location of an observation as issue identity needs it: its role, its file or withheld key, the symbol it
 * sits in and a digest of the cited text, never a line number.
 */
export interface Anchor {
  readonly role: AnchorRole;
  readonly sourceId: string;
  /** Null when the producer withheld the location (secret-scan citations name a capture entry, never a path). */
  readonly relativePath: string | null;
  readonly withheld: boolean;
  readonly content: ArtifactId;
  /**
   * For a withheld location only: an opaque key for the cited file, never its path. Two files with the same bytes are
   * two locations; by default the capture entry, which a caller holding the private snapshot may replace with a key
   * that is stable across captures (withheldKey).
   */
  readonly locationKey: string | null;
  readonly span: { readonly startByte: number; readonly endByte: number };
  /** The canonical graph symbol the evidence sits in, when the producer or parser named one. */
  readonly nodeId: string | null;
  /** Digest of the cited bytes with whitespace runs collapsed: stable under line movement. */
  readonly textDigest: Digest;
  /** The evidence's own index in the observation, for citing it back. */
  readonly evidenceIndex: number;
}

/**
 * An observation with what identity and reporting derive from it: the rule family, the mapped severity beside the
 * original, the anchors and whether it concerns a secret. The original envelope is kept unchanged.
 */
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
  critical: 'critical',
  blocker: 'critical',
  high: 'high',
  error: 'high',
  major: 'high',
  medium: 'medium',
  moderate: 'medium',
  warning: 'medium',
  low: 'low',
  minor: 'low',
  note: 'low',
  info: 'info',
  informational: 'info',
  none: 'info',
};

const sha = (b: string | Uint8Array): Digest => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** True when the observation's rule family or one of its limitation keys is in `sentinel.secrets.*`. */
export const isSecretObservation = (o: ObservationEnvelope): boolean =>
  (o.rule?.familyId ?? '').startsWith('sentinel.secrets.') ||
  o.limitationKeys.some((k) => k.startsWith('sentinel.secrets.'));

/** The role of evidence `i` of `n`: a lone citation is `single`; otherwise the first is the source, the last the sink. */
function roleOf(i: number, n: number): AnchorRole {
  if (n === 1) return 'single';
  if (i === 0) return 'source';
  if (i === n - 1) return 'sink';
  return 'step';
}

function producerOf(o: ObservationEnvelope): string {
  const p = o.producer;
  return p.kind === 'imported' ? `imported:${p.provenanceArtifact}` : `${p.kind}:${p.adapterId}`;
}

/** Options for `normalizeObservation`. */
export interface NormalizeOptions {
  /** An opaque key for a withheld citation's file (never its path); the capture entry when absent. */
  readonly withheldKey?: (evidence: WithheldLocationEvidence) => string;
}

/**
 * Normalizes one observation, reading each cited content at most once through `cache`. A withheld location is never
 * read or turned into a path; an unrecognized severity maps to `info` with `severityUnmapped`, never upward; the
 * observation is a secret when its rule or limitations say so or any citation is withheld.
 */
export async function normalizeObservation(
  o: ObservationEnvelope,
  readContent: (id: ArtifactId) => Promise<Uint8Array>,
  cache: Map<string, Promise<Uint8Array>> = new Map(),
  options: NormalizeOptions = {},
): Promise<NormalizedObservation> {
  const read = (id: string) => {
    let p = cache.get(id);
    if (!p) cache.set(id, (p = readContent(id)));
    return p;
  };
  const anchors: Anchor[] = [];
  const n = o.evidence.length;
  for (let i = 0; i < n; i++) {
    const e = o.evidence[i]!;
    const role = roleOf(i, n);
    if ('location' in e) {
      // A withheld location is never read or turned into a path: its identity is an opaque key for the file, the cited
      // content and the span. Identical bytes in two files are two locations, never one.
      const locationKey = options.withheldKey ? options.withheldKey(e) : `entry:${e.entry}`;
      anchors.push({
        role,
        sourceId: e.sourceId,
        relativePath: null,
        withheld: true,
        content: e.content,
        locationKey,
        span: { startByte: e.span.startByte, endByte: e.span.endByte },
        nodeId: null,
        textDigest: sha(
          `withheld\u0000${locationKey}\u0000${e.content}\u0000${e.span.startByte}\u0000${e.span.endByte}`,
        ),
        evidenceIndex: i,
      });
      continue;
    }
    const bytes = await read(e.content);
    const slice = Buffer.from(bytes).subarray(
      Math.min(e.span.startByte, bytes.length),
      Math.min(e.span.endByte, bytes.length),
    );
    const text = slice.toString('utf8').replace(/\s+/g, ' ').trim();
    anchors.push({
      role,
      sourceId: e.sourceId,
      relativePath: e.relativePath,
      withheld: false,
      content: e.content,
      locationKey: null,
      span: { startByte: e.span.startByte, endByte: e.span.endByte },
      nodeId: e.nodeId ?? null,
      textDigest: sha(text),
      evidenceIndex: i,
    });
  }
  const original = o.originalSeverity;
  const mapped = SEVERITY_ALIASES[original.trim().toLowerCase()];
  const familyId =
    o.rule?.familyId ?? `${o.producer.kind === 'imported' ? 'imported' : o.producer.adapterId}/${o.producerRuleId}`;
  return {
    observationId: o.id,
    snapshotId: o.snapshotId,
    producer: producerOf(o),
    ruleFamilyId: familyId,
    ruleRevision: o.rule?.revisionDigest ?? null,
    severity: mapped ?? 'info',
    originalSeverity: original,
    severityUnmapped: !mapped,
    anchors,
    secret: isSecretObservation(o) || anchors.some((a) => a.withheld),
    observation: o,
  };
}
