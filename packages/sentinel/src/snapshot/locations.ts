// Resolving a withheld location (ADR 28): a `WithheldLocationEvidence` names a capture entry by its index in the
// snapshot's `entries`, never by a path. Only this resolver, over the private snapshot, turns it into the entry and
// its path, and only when the snapshot, the source, the entry kind and the content digest all agree, so two files with
// the same bytes resolve to their own entries and a reference cannot be pointed at another file. It reads nothing but
// the snapshot it is given and does one bounded lookup.
import type {
  CaptureEntry,
  IncludedFileEntry,
  SnapshotEnvelope,
  WithheldLocationEvidence,
} from '../contracts/index.js';
import type { SnapshotErrorCode } from './errors.js';

/** A withheld location resolved to its captured entry, or the one reason it could not be. */
export type ResolvedLocation =
  | { readonly ok: true; readonly entry: IncludedFileEntry }
  | { readonly ok: false; readonly reasonCode: Extract<SnapshotErrorCode, 'sentinel.capture.locationUnresolved'> };

const refused = { ok: false, reasonCode: 'sentinel.capture.locationUnresolved' } as const;

/**
 * The included file a withheld location names in this snapshot. Refused (`locationUnresolved`) for another snapshot,
 * an entry out of range, or an entry that is not an included file; it never falls back to a path.
 */
export function resolveWithheldLocation(
  snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>,
  evidence: WithheldLocationEvidence,
): ResolvedLocation {
  if (!evidence || evidence.location !== 'withheld' || evidence.snapshotId !== snapshot.id) return refused;
  if (!Number.isSafeInteger(evidence.entry) || evidence.entry < 0 || evidence.entry >= snapshot.entries.length)
    return refused;
  const entry: CaptureEntry | undefined = snapshot.entries[evidence.entry];
  if (!entry || entry.kind !== 'file' || entry.disposition !== 'included') return refused;
  if (entry.sourceId !== evidence.sourceId || entry.content !== evidence.content) return refused;
  return { ok: true, entry };
}
