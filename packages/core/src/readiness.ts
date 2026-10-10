/**
 * The release readiness brief (round 2026-10-10, proposal 6): one storyline, one row per step and per
 * branch — is it built, its own verdict and the day of its last run (`testVerdict()`, the one verdict),
 * the cases skipped and never run, the gates no test is known to reach, the commits since its last green
 * run, and **ship or hold with the reason**. Under it a rules register: every gate and rule the storyline's
 * screens meet, in the words somebody wrote for it, with the screens it sits on, the cases that reach it
 * and the owner the design names.
 *
 * The policy is stated, not tuned: a row **holds** when a screen it names is not built, or a case in its
 * scope failed or was skipped on its own last run. Nothing else holds a row — a step no run names ships
 * with that said beside it (its verdict word), because the brief prints evidence and its absence, never
 * a confidence it does not have. Pure over the graph; the commits come from a callback the caller backs
 * with the commit spine (server: `SnapshotDb.commitsTouching`), absent = not known.
 */
import type { GraphNode } from './graph.js';
import { type GraphIndex, journey, journeySummary } from './query.js';
import { screensFor } from './design.js';
import { counted, type Counted } from './counts.js';
import { gateCard, gateNameParts } from './gates.js';
import type { CoverageTestRef, EvidenceWord } from './coverage.js';
import type { JourneyTree, JourneyStoryline, JourneyRow } from './journeys.js';

/** Why a row holds — a closed set, printed through `readiness.hold.<reason>`. */
export const READINESS_HOLD_REASONS = ['notBuilt', 'failed', 'skipped'] as const;
export type ReadinessHoldReason = typeof READINESS_HOLD_REASONS[number];

export interface ReadinessRow {
  /** `1`, `2`, … for a step; `2b` for a branch that leaves step 2 (`2c` for a second) */
  label: string;
  kind: 'step' | 'branch';
  flowId: string;
  name: string;
  description?: string;
  /** a branch: the step it leaves from and the condition that takes it */
  branchOf?: { flowId: string; name: string; when: string };
  screens: { id: string; name: string; built: boolean }[];
  built: { all: boolean; n: number; of: number };
  /** the journey's one verdict, as the Map and the journey print it */
  verdict: { word: EvidenceWord; status?: string; runs: Counted } | null;
  /** the newest run of a case in scope */
  lastRun: string | null;
  /** the newest run of a case that passed — the last green run */
  lastGreen: string | null;
  skipped: number;
  failed: number;
  unrun: number;
  /** gates and rules on the journey's screens (config checks apart), and those no test is known to reach */
  gates: { n: number; unreached: { id: string; name: string }[] };
  /** commits touching the journey's parts after its last green run; null when not known (no spine, no green run) */
  commitsSince: number | null;
  ship: boolean;
  hold: ReadinessHoldReason[];
  owner?: string;
}

export interface ReadinessRule {
  id: string;
  name: string;
  kind: 'guard' | 'rule';
  /** the identifier the gate was declared with, when its name carries one */
  ident: string;
  /** the words somebody wrote: `@business`, else the requirement after `@guard`'s colon; absent when nobody did */
  words?: string;
  screens: number;
  /** distinct cases that reach the gate or a call it guards (the gate card's own list) */
  tests: number;
  /** the owners the design names for the journeys that meet it */
  owners: string[];
}

export interface Readiness {
  storyline: { id: string; name: string; description?: string; repo: string };
  rows: ReadinessRow[];
  rules: ReadinessRule[];
  counted: { steps: Counted; ship: Counted; hold: Counted; skipped: Counted; unreached: Counted; rules: Counted };
}

const SRC = 'core readiness.ts readiness';
type CommitsSince = (repo: string, parts: { node: string; path?: string }[], since: string) => number | null;

/** The brief for one storyline; undefined when the tree declares no storyline of that id. */
export function readiness(index: GraphIndex, tree: JourneyTree, storylineId: string, opts: { commitsSince?: CommitsSince; repo?: string } = {}): Readiness | undefined {
  // two sources may each declare a storyline of the same id: `repo` names the one asked for
  const st: JourneyStoryline | undefined = tree.storylines.find((s) => s.id === storylineId && (!opts.repo || s.repo === opts.repo));
  if (!st) return undefined;
  const cards = new Map<string, ReturnType<typeof gateCard>>();
  const card = (id: string) => { if (!cards.has(id)) cards.set(id, gateCard(index, id)); return cards.get(id); };
  const rules = new Map<string, { node: GraphNode; screens: Set<string>; owners: Set<string> }>();
  const allCases = new Map<string, CoverageTestRef>();

  const rowFor = (r: JourneyRow, label: string, kind: 'step' | 'branch'): ReadinessRow => {
    let screens: ReadinessRow['screens'] = [];
    let verdict: ReadinessRow['verdict'] = null;
    let refs: CoverageTestRef[] = [];
    const gateIds = new Set<string>();
    const parts: { node: string; path?: string }[] = [];
    try {
      const j = journey(index, r.nodeId);
      const sum = journeySummary(index, j, screensFor(index, r.nodeId));
      screens = sum.user.map((u) => ({ id: u.id, name: u.name, built: !!u.loc }));
      for (const seg of sum.segments) for (const g of seg.gates) {
        if (g.planned) continue;
        gateIds.add(g.id);
        const n = index.byId.get(g.id);
        if (!n) continue;
        const e = rules.get(g.id) ?? { node: n, screens: new Set<string>(), owners: new Set<string>() };
        if (seg.screen) e.screens.add(seg.screen.id);
        if (r.owner) e.owners.add(r.owner);
        rules.set(g.id, e);
      }
      const seen = new Set<string>();
      for (const s of j.steps) {
        if (seen.has(s.nodeId)) continue;
        seen.add(s.nodeId);
        const n = index.byId.get(s.nodeId);
        if (n?.loc) parts.push({ node: n.id, path: n.loc.path });
      }
      const cov = sum.coverage?.journey;
      if (cov) {
        verdict = { word: cov.verdict.word, ...(cov.verdict.status ? { status: cov.verdict.status } : {}), runs: cov.verdict.runs };
        refs = cov.tests.filter((t) => !t.runLevel);
      }
    } catch { /* a journey that cannot be walked: its row says what the tree knows and nothing more */ }
    for (const t of refs) allCases.set(t.id, t);
    const part = (k: string) => verdict?.runs.breakdown?.find((p) => p.key === `count.part.${k}`)?.n ?? 0;
    const ats = refs.map((t) => t.at).filter((x): x is string => !!x).sort();
    const greens = refs.filter((t) => t.status === 'passed' && t.at).map((t) => t.at!).sort();
    const lastGreen = greens.pop() ?? null;
    const unreached = [...gateIds].filter((id) => (card(id)?.tests.length ?? 0) === 0)
      .map((id) => ({ id, name: index.byId.get(id)?.name ?? id }));
    const builtN = screens.length ? screens.filter((s) => s.built).length : r.built;
    const of = screens.length || r.total;
    const allBuilt = of > 0 ? builtN === of : r.status === 'both';
    const hold: ReadinessHoldReason[] = [];
    if (!allBuilt) hold.push('notBuilt');
    if (part('failed')) hold.push('failed');
    if (part('skipped')) hold.push('skipped');
    const commitsSince = lastGreen && opts.commitsSince && parts.length ? opts.commitsSince(r.repo, parts, lastGreen) : null;
    return {
      label, kind, flowId: r.nodeId, name: r.name,
      ...(r.description ? { description: r.description } : {}),
      screens,
      built: { all: allBuilt, n: builtN, of },
      verdict,
      lastRun: ats.pop() ?? null,
      lastGreen,
      skipped: part('skipped'), failed: part('failed'), unrun: part('noRun'),
      gates: { n: gateIds.size, unreached },
      commitsSince,
      ship: hold.length === 0,
      hold,
      ...(r.owner ? { owner: r.owner } : {}),
    };
  };

  const rows: ReadinessRow[] = [];
  st.journeys.forEach((step, i) => {
    rows.push(rowFor(step, String(i + 1), 'step'));
    const off = (st.branches ?? []).filter((b) => b.branchOf === step.nodeId);
    off.forEach((b, k) => {
      const row = rowFor(b, String(i + 1) + String.fromCharCode(98 + k), 'branch');
      row.branchOf = { flowId: b.branchOf, name: b.branchOfName, when: b.when };
      rows.push(row);
    });
  });

  const ruleRows: ReadinessRule[] = [...rules.values()].map(({ node, screens, owners }) => {
    const c = card(node.id);
    const { ident, phrase } = gateNameParts(node.name);
    const words = c?.gate.business ?? (ident ? phrase : undefined);
    return {
      id: node.id, name: node.name, kind: node.kind === 'rule' ? 'rule' as const : 'guard' as const, ident: ident || node.name,
      ...(words ? { words } : {}),
      screens: screens.size,
      tests: c ? c.tests.filter((t) => !t.runLevel).length : 0,
      owners: [...owners].sort(),
    };
  }).sort((a, b) => b.screens - a.screens || a.name.localeCompare(b.name));

  const steps = rows.filter((r) => r.kind === 'step').length;
  const ship = rows.filter((r) => r.ship).length;
  const unreachedIds = new Set(rows.flatMap((r) => r.gates.unreached.map((g) => g.id)));
  const skippedCases = [...allCases.values()].filter((t) => t.status === 'skipped').length;
  const scope = 'count.scope.storyline' as const;
  return {
    storyline: { id: st.id, name: st.name, ...(st.description ? { description: st.description } : {}), repo: st.repo },
    rows,
    rules: ruleRows,
    counted: {
      steps: counted(rows.length, 'count.unit.journeys', scope, `${SRC} → storyline steps and branches`, {
        bizUnit: 'count.unit.journeys',
        breakdown: [{ key: 'count.part.storylineSteps', n: steps }, { key: 'count.part.storylineBranches', n: rows.length - steps }],
      }),
      ship: counted(ship, 'count.unit.readinessShip', scope, `${SRC} → rows with no hold reason`, { bizUnit: 'count.unit.readinessShip' }),
      hold: counted(rows.length - ship, 'count.unit.readinessHold', scope, `${SRC} → rows with a hold reason`, {
        bizUnit: 'count.unit.readinessHold',
        breakdown: [
          { key: 'count.part.holdNotBuilt', n: rows.filter((r) => r.hold[0] === 'notBuilt').length },
          { key: 'count.part.holdFailed', n: rows.filter((r) => r.hold[0] === 'failed').length },
          { key: 'count.part.holdSkipped', n: rows.filter((r) => r.hold[0] === 'skipped').length },
        ],
      }),
      skipped: counted(skippedCases, 'count.unit.readinessSkipped', scope, `${SRC} → distinct cases over the storyline whose own last run skipped`, { bizUnit: 'count.unit.readinessSkipped' }),
      unreached: counted(unreachedIds.size, 'count.unit.readinessUnreached', scope, `${SRC} → distinct gates on its screens with no case in their gate card`, { bizUnit: 'count.unit.readinessUnreached' }),
      rules: counted(ruleRows.length, 'count.unit.readinessRules', scope, `${SRC} → distinct gates and rules on its screens`, { bizUnit: 'count.unit.readinessRules' }),
    },
  };
}

/** The brief as a spreadsheet: one line per row, the words a reader sees (the CLI and the viewer's CSV). */
export function readinessCsvRows(r: Readiness, word: (key: string) => string): { header: string[]; rows: string[][] } {
  const header = ['step', 'journey', 'kind', 'branch_of', 'when', 'built', 'screens_built', 'screens', 'verdict', 'last_run', 'skipped', 'failed', 'unrun', 'gates', 'gates_no_test', 'commits_since_green', 'decision', 'reasons', 'owner'];
  const rows = r.rows.map((x) => [
    x.label, x.name, x.kind, x.branchOf?.name ?? '', x.branchOf?.when ?? '',
    x.built.all ? 'yes' : 'no', String(x.built.n), String(x.built.of),
    x.verdict ? word(x.verdict.word.key) : '', x.lastRun ?? '',
    String(x.skipped), String(x.failed), String(x.unrun), String(x.gates.n), String(x.gates.unreached.length),
    x.commitsSince == null ? '' : String(x.commitsSince),
    x.ship ? 'ship' : 'hold', x.hold.map((h) => word(`readiness.hold.${h}`)).join(' · '), x.owner ?? '',
  ]);
  return { header, rows };
}
