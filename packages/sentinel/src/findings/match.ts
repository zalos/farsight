// Matching findings across runs (PR 19, ADR 38). An exact match is one baseline and one current finding with the same
// exact fingerprint (rule family and anchor set: symbols and cited text). A probable match is one-to-one on the
// probable fingerprint (rule family and symbols) after exact matching: the cited code changed inside the same
// declarations, so the pairing needs review. Whenever a key is shared by more than one finding on either side, the
// pairing is ambiguous and nothing is chosen: the first candidate is never taken, and distinct weaknesses that share
// a sink or a symbol name stay distinct.

export interface MatchableFinding {
  readonly id: string;
  readonly fingerprint: { readonly version: string; readonly exact: string; readonly probable: string };
}

export interface MatchResult {
  readonly exact: readonly { readonly baseline: string; readonly current: string }[];
  readonly probable: readonly { readonly baseline: string; readonly current: string }[];
  /** Groups that share a key with more than one finding on a side: none of them is paired. */
  readonly ambiguous: readonly { readonly baseline: readonly string[]; readonly current: readonly string[] }[];
  readonly unmatchedBaseline: readonly string[];
  readonly unmatchedCurrent: readonly string[];
}

export class MatchError extends Error {
  constructor(message: string) { super(message); this.name = 'MatchError'; }
}

export function matchFindings(baseline: readonly MatchableFinding[], current: readonly MatchableFinding[]): MatchResult {
  for (const f of [...baseline, ...current]) {
    if (f.fingerprint.version !== (baseline[0] ?? current[0])!.fingerprint.version) {
      throw new MatchError('fingerprints of different versions are not compared');
    }
  }
  const exact: { baseline: string; current: string }[] = [];
  const probable: { baseline: string; current: string }[] = [];
  const ambiguous: { baseline: string[]; current: string[] }[] = [];
  let bLeft = [...baseline];
  let cLeft = [...current];
  for (const [key, out] of [['exact', exact], ['probable', probable]] as const) {
    const bBy = groupBy(bLeft, f => f.fingerprint[key]);
    const cBy = groupBy(cLeft, f => f.fingerprint[key]);
    const pairedB = new Set<string>();
    const pairedC = new Set<string>();
    for (const [k, bs] of bBy) {
      const cs = cBy.get(k);
      if (!cs) continue;
      if (bs.length === 1 && cs.length === 1) out.push({ baseline: bs[0]!.id, current: cs[0]!.id });
      else ambiguous.push({ baseline: bs.map(f => f.id).sort(), current: cs.map(f => f.id).sort() });
      for (const f of bs) pairedB.add(f.id);
      for (const f of cs) pairedC.add(f.id);
    }
    bLeft = bLeft.filter(f => !pairedB.has(f.id));
    cLeft = cLeft.filter(f => !pairedC.has(f.id));
  }
  return {
    exact: exact.sort(byIds), probable: probable.sort(byIds), ambiguous,
    unmatchedBaseline: bLeft.map(f => f.id).sort(), unmatchedCurrent: cLeft.map(f => f.id).sort(),
  };
}

const byIds = (a: { baseline: string; current: string }, b: { baseline: string; current: string }) => (a.current < b.current ? -1 : a.current > b.current ? 1 : 0);

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of items) m.set(key(t), [...m.get(key(t)) ?? [], t]);
  return m;
}
