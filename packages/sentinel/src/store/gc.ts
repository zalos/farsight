// Reachability inspection and a dry-run prune plan for the object store. Read-only by construction: this module
// imports no filesystem function and calls only ObjectStore.list() and ObjectStore.check(). PR 03 deletes nothing and schedules no
// retention; a plan is evidence for a later, separately reviewed pruning step.
//
// Everything a root names is protected in every codec, and so is everything reachable from it through artifact
// links (cycles and shared children included). An incomplete, malformed or moving snapshot fails closed, and so
// does any reachable or recorded object that is missing or does not verify: the plan then lists no candidate.
import { type ObjectRef, type ObjectStore, type PhysicalObject, artifactIdOf } from './objects.js';

export const GC_ROOT_KINDS = ['referenced', 'retained', 'active', 'staged', 'report', 'pinned'] as const;
export type GcRootKind = typeof GC_ROOT_KINDS[number];

/** The minimal seam this module needs from the ledger (PR 03 lane B): one committed snapshot of roots and links. */
export interface ReachabilitySnapshot {
  readonly storeId: string;
  /** The ledger's committed snapshot sequence the roots and links were read at. */
  readonly sequence: number;
  /** False when the ledger could not enumerate every root or link; the plan then fails closed. */
  readonly complete: boolean;
  readonly roots: readonly { readonly kind: GcRootKind; readonly id: string; readonly artifacts: readonly string[] }[];
  /** Parent → child artifact references (a report → its findings → their evidence, …). */
  readonly links: readonly { readonly from: string; readonly to: string }[];
  /** Every physical representation the ledger recorded a receipt for; each must exist and verify. */
  readonly recorded?: readonly ObjectRef[];
}

export type GcErrorCode =
  | 'sentinel.gc.incompleteSnapshot' | 'sentinel.gc.wrongStore' | 'sentinel.gc.invalidSnapshot'
  | 'sentinel.gc.missingReachable' | 'sentinel.gc.missingRecorded' | 'sentinel.gc.corruptObject'
  | 'sentinel.gc.snapshotMoved' | 'sentinel.gc.sequenceUnverified' | 'sentinel.gc.unreadableStore';

export interface GcError { readonly code: GcErrorCode; readonly detail: string }

export interface ReachabilityReport {
  readonly ok: boolean;
  readonly storeId: string;
  readonly sequence: number | null;
  readonly errors: readonly GcError[];
  /** Every logical artifact protected by a root, sorted. */
  readonly reachable: readonly string[];
  readonly rootCounts: Readonly<Record<GcRootKind, number>>;
  /** Staged artifacts not written yet: registration precedes the write, so this is expected and protected. */
  readonly pendingStaged: readonly string[];
  readonly physical: {
    readonly objects: number;
    readonly protectedObjects: number;
    readonly unreachableObjects: number;
    readonly staging: readonly string[];
    readonly unexpected: readonly string[];
  };
}

export interface PrunePlan {
  readonly dryRun: true;
  /** Always zero: nothing in PR 03 removes an object. */
  readonly deleted: 0;
  readonly ok: boolean;
  /** The plan is valid only for this store at this snapshot sequence. */
  readonly validFor: { readonly storeId: string; readonly sequence: number | null };
  readonly errors: readonly GcError[];
  /** Unreachable published objects. Empty whenever `ok` is false. */
  readonly candidates: readonly PhysicalObject[];
  readonly candidateBytes: number;
  /** Never candidates: staged partial files and anything outside the layout. */
  readonly retained: { readonly staging: readonly string[]; readonly unexpected: readonly string[] };
  readonly report: ReachabilityReport;
}

export interface InspectOptions {
  /**
   * Required. Re-reads the ledger's committed sequence after the store was listed. Every staging registration
   * advances the sequence before its bytes are written, so an unchanged sequence proves no object in the listing
   * was registered after the snapshot; a different, unreadable or non-integer answer fails the inspection closed.
   */
  readonly readSequence: () => number | Promise<number>;
}

const ARTIFACT_ID = /^sha256:[0-9a-f]{64}$/;

/** A real array with every index present: a sparse list could hide a root from the walk. */
function isDenseList(v: unknown): v is readonly unknown[] {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i)) return false;
  return true;
}

function validate(store: ObjectStore, snapshot: ReachabilitySnapshot, errors: GcError[]): boolean {
  if (!snapshot || typeof snapshot !== 'object') {
    errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: 'no snapshot' });
    return false;
  }
  if (snapshot.storeId !== store.storeId) errors.push({ code: 'sentinel.gc.wrongStore', detail: 'the snapshot names another store' });
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: 'sequence is not a non-negative integer' });
  if (snapshot.complete !== true) errors.push({ code: 'sentinel.gc.incompleteSnapshot', detail: 'the ledger did not enumerate every root and link' });
  if (!isDenseList(snapshot.roots) || !isDenseList(snapshot.links)) {
    errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: 'roots and links must be dense lists' });
    return false;
  }
  snapshot.roots.forEach((root, i) => {
    if (!root || !GC_ROOT_KINDS.includes(root.kind)) errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: `root ${i} has an unknown kind` });
    if (!root || typeof root.id !== 'string' || !root.id) errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: `root ${i} has no id` });
    if (!root || !isDenseList(root.artifacts)) { errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: `root ${i} has no dense artifact list` }); return; }
    for (const a of root.artifacts) if (typeof a !== 'string' || !ARTIFACT_ID.test(a)) errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: `root ${i} names an invalid artifact id` });
  });
  snapshot.links.forEach((link, i) => {
    if (!link || typeof link.from !== 'string' || !ARTIFACT_ID.test(link.from) || typeof link.to !== 'string' || !ARTIFACT_ID.test(link.to)) {
      errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: `link ${i} names an invalid artifact id` });
    }
  });
  if (snapshot.recorded !== undefined && !isDenseList(snapshot.recorded)) {
    errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: 'recorded must be a dense list' });
  }
  return true;
}

/** Walks the snapshot against what is on disk. Never writes. */
export async function inspectReachability(store: ObjectStore, snapshot: ReachabilitySnapshot, options: InspectOptions): Promise<ReachabilityReport> {
  return (await inspect(store, snapshot, options)).report;
}

async function inspect(store: ObjectStore, snapshot: ReachabilitySnapshot, options: InspectOptions): Promise<{ report: ReachabilityReport; objects: readonly PhysicalObject[] }> {
  const errors: GcError[] = [];
  const structured = validate(store, snapshot, errors);
  const rootCounts = Object.fromEntries(GC_ROOT_KINDS.map(k => [k, 0])) as Record<GcRootKind, number>;
  const reachable = new Set<string>();
  const stagedOnly = new Set<string>();
  const accepted = new Set<string>();

  if (structured) {
    const children = new Map<string, string[]>();
    for (const link of snapshot.links) {
      if (!link || typeof link.from !== 'string' || typeof link.to !== 'string') continue;
      const list = children.get(link.from);
      if (list) list.push(link.to); else children.set(link.from, [link.to]);
    }
    const queue: string[] = [];
    for (const root of snapshot.roots) {
      if (!root || !Array.isArray(root.artifacts)) continue;
      if (GC_ROOT_KINDS.includes(root.kind)) rootCounts[root.kind]++;
      for (const a of root.artifacts) {
        if (typeof a !== 'string') continue;
        if (root.kind === 'staged') stagedOnly.add(a); else accepted.add(a);
        if (!reachable.has(a)) { reachable.add(a); queue.push(a); }
      }
    }
    // Iterative breadth-first walk with a visited set: cycles terminate, shared children are visited once.
    while (queue.length) {
      const next = queue.shift()!;
      for (const child of children.get(next) ?? []) {
        accepted.add(child);
        if (!reachable.has(child)) { reachable.add(child); queue.push(child); }
      }
    }
    for (const a of accepted) stagedOnly.delete(a);
  }

  let listing: Awaited<ReturnType<ObjectStore['list']>> | undefined;
  try {
    listing = await store.list();
  } catch (e) {
    errors.push({ code: 'sentinel.gc.unreadableStore', detail: (e as Error).message });
  }

  const present = new Set<string>();
  let protectedObjects = 0;
  for (const obj of listing?.objects ?? []) {
    const id = artifactIdOf(obj.rawDigest);
    present.add(id);
    if (reachable.has(id)) protectedObjects++;
  }
  const pendingStaged: string[] = [];
  for (const id of [...reachable].sort()) {
    if (present.has(id) || !listing) continue;
    if (stagedOnly.has(id)) pendingStaged.push(id);
    else errors.push({ code: 'sentinel.gc.missingReachable', detail: `${id} is referenced but has no published object` });
  }

  if (listing && structured) {
    // Every physical file of a reachable artifact must verify: a corrupt or aliased protected object is an
    // integrity failure.
    for (const obj of listing.objects) {
      if (!reachable.has(artifactIdOf(obj.rawDigest))) continue;
      const c = await checkOrError(store, { rawDigest: obj.rawDigest, codec: obj.codec, encodedSize: obj.encodedSize });
      if (c) errors.push({ code: c.status === 'missing' ? 'sentinel.gc.missingReachable' : 'sentinel.gc.corruptObject', detail: `${obj.relPath}: ${c.detail}` });
    }
    // What the ledger says is stored must be stored, as recorded.
    const files = new Set(listing.objects.map(o => `${o.rawDigest}.${o.codec}`));
    for (const [i, ref] of (isDenseList(snapshot.recorded) ? snapshot.recorded as readonly ObjectRef[] : []).entries()) {
      if (!ref || typeof ref.rawDigest !== 'string' || !/^[0-9a-f]{64}$/.test(ref.rawDigest)) {
        errors.push({ code: 'sentinel.gc.invalidSnapshot', detail: `recorded object ${i} has no valid digest` });
        continue;
      }
      if (!files.has(`${ref.rawDigest}.${ref.codec}`)) {
        errors.push({ code: 'sentinel.gc.missingRecorded', detail: `${artifactIdOf(ref.rawDigest)} (${String(ref.codec)}) is recorded but not stored` });
        continue;
      }
      const c = await checkOrError(store, ref);
      if (c) errors.push({ code: 'sentinel.gc.corruptObject', detail: `${artifactIdOf(ref.rawDigest)} (${ref.codec}): ${c.detail}` });
    }
  }

  if (typeof options?.readSequence !== 'function') {
    errors.push({ code: 'sentinel.gc.sequenceUnverified', detail: 'no way to re-read the committed sequence was given' });
  } else if (structured) {
    let after: unknown;
    let read = false;
    try { after = await options.readSequence(); read = true; } catch (e) {
      errors.push({ code: 'sentinel.gc.sequenceUnverified', detail: `the committed sequence could not be re-read: ${(e as Error).message}` });
    }
    if (read && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)) {
      errors.push({ code: 'sentinel.gc.sequenceUnverified', detail: 'the re-read sequence is not a non-negative integer' });
    } else if (read && after !== snapshot.sequence) {
      errors.push({ code: 'sentinel.gc.snapshotMoved', detail: `the ledger moved from sequence ${snapshot.sequence} to ${String(after)} during inspection` });
    }
  }

  const objectCount = listing?.objects.length ?? 0;
  const report: ReachabilityReport = Object.freeze({
    ok: errors.length === 0,
    storeId: store.storeId,
    sequence: structured && Number.isSafeInteger(snapshot.sequence) ? snapshot.sequence : null,
    errors: Object.freeze(errors),
    reachable: Object.freeze([...reachable].sort()),
    rootCounts: Object.freeze(rootCounts),
    pendingStaged: Object.freeze(pendingStaged),
    physical: Object.freeze({
      objects: objectCount,
      protectedObjects,
      unreachableObjects: objectCount - protectedObjects,
      staging: listing?.staging ?? [],
      unexpected: listing?.unexpected ?? [],
    }),
  });
  return { report, objects: listing?.objects ?? [] };
}

/** A failed check, or undefined when the object verifies. Errors that are not about the object become failures too. */
async function checkOrError(store: ObjectStore, ref: ObjectRef): Promise<{ status: string; detail: string } | undefined> {
  try {
    const c = await store.check(ref);
    return c.status === 'ok' ? undefined : c;
  } catch (e) {
    return { status: 'corrupt', detail: (e as Error).message };
  }
}

/** Lists what a prune would remove at this snapshot, and removes nothing. */
export async function planPrune(store: ObjectStore, snapshot: ReachabilitySnapshot, options: InspectOptions): Promise<PrunePlan> {
  const { report, objects } = await inspect(store, snapshot, options);
  const reachable = new Set(report.reachable);
  // One listing, taken after the snapshot was read. An object published after the snapshot is registered as a
  // staged root first, which advances the sequence: pass `readSequence` and that race fails the plan closed.
  const candidates = report.ok ? objects.filter(o => !reachable.has(artifactIdOf(o.rawDigest))) : [];
  return Object.freeze({
    dryRun: true,
    deleted: 0,
    ok: report.ok,
    validFor: Object.freeze({ storeId: report.storeId, sequence: report.sequence }),
    errors: report.errors,
    candidates: Object.freeze(candidates),
    candidateBytes: candidates.reduce((n, o) => n + o.encodedSize, 0),
    retained: Object.freeze({ staging: report.physical.staging, unexpected: report.physical.unexpected }),
    report,
  });
}
