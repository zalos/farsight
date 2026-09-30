import type { GraphNode, GraphEdge, NodeKind, Loc, ConfidenceTier, ResolutionTechnique } from './graph.js';
import type { GraphStore, GraphMeta } from './store.js';
import type { RowChange } from './snapshots.js';
import type { FileAttribution } from './history.js';
import { buildIndex, journey } from './query.js';

/**
 * farsight-diff v1 — the frozen change contract between two graph snapshots.
 * Prose contract: docs/contracts/farsight-diff-v1.md
 * JSON Schema:    schemas/farsight-diff-v1.schema.json
 *
 * Facts live here; judgment lives in the policy file (`applyPolicy`). The
 * diff never decides — it reports what changed, how sure we are, and lets a
 * repo-owned compliance.yml turn that into an exit code.
 */

// ── contract shapes (frozen — see the contract doc before touching) ────────

export type ChangeKind =
  | 'route_added' | 'route_removed'
  | 'guard_added' | 'guard_removed'
  | 'journey_changed'
  | 'record_added' | 'record_removed' | 'record_columns_changed'
  | 'message_added' | 'message_removed'
  | 'rule_added' | 'rule_removed'
  | 'edge_confidence_changed'
  | 'node_renamed'
  // additive 2026-09 (tests in the graph) — see the version note in the contract doc
  | 'test_added' | 'test_removed'
  | 'coverage_lost' | 'uncovered_change';

export interface DiffChange {
  id: string;                                  // "c1" — stable within a diff, referenced by permalinks
  kind: ChangeKind;
  severity: 'breaking' | 'notable' | 'info';
  confidence: ConfidenceTier | 'resolved';
  technique?: ResolutionTechnique;
  subject: { id: string; name: string; kind: NodeKind };   // stable id + display name
  journey?: { id: string; name: string };
  loc?: Loc;
  permalink: string;                           // /compare/39...41#c1
  /**
   * Optional (v1 addition, 2026-09): on a `journey_changed` whose entry is a route, the
   * contract status on each side when they differ — `spec-only → both` is "planned → built".
   */
  contractStatus?: { from: 'both' | 'spec-only' | 'code-only' | 'declared' | 'none'; to: 'both' | 'spec-only' | 'code-only' | 'declared' | 'none' };
  /**
   * Optional (v1 addition, 2026-09-23): the commits in the compared range that touched
   * **the file this change's subject lives in** — file-level provenance, never proof
   * that a commit changed this node (change-history-2026-09.md §2). `level` is the
   * literal `'file'` so no consumer can read it as node-level, and `unindexed` counts
   * the commits in the list that no sync ever ingested, which makes the list a floor.
   *
   * `diffGraphs` never sets it and this module never reads git: `attributeChanges()`
   * in `history.ts` adds it on the way out, over a copy, which is why the golden
   * fixture still holds. Absent means no history has been read for that repository;
   * `commits: []` means the history was read and nothing in the range touched the file.
   */
  attribution?: FileAttribution;
}

export interface GraphDiff {
  schema: 'farsight-diff v1';
  base: string; head: string;                  // "sync:39 · 76f7674"
  truncated: boolean;                          // counts stay complete even when changes are cut
  counts: Record<ChangeKind, number>;
  changes: DiffChange[];
  gate?: {
    policy: string;
    result: 'pass' | 'fail';
    exit: 0 | 1;
    rules: { rule: string; result: string; changes: string[] }[];
  };
}

export const CHANGE_KINDS: ChangeKind[] = [
  'route_added', 'route_removed',
  'guard_added', 'guard_removed',
  'journey_changed',
  'record_added', 'record_removed', 'record_columns_changed',
  'message_added', 'message_removed',
  'rule_added', 'rule_removed',
  'edge_confidence_changed',
  'node_renamed',
  'test_added', 'test_removed',
  'coverage_lost', 'uncovered_change',
];

/** Severity is a fact of the contract (documented in farsight-diff-v1.md), not a judgment call per diff. */
const SEVERITY: Record<ChangeKind, DiffChange['severity']> = {
  route_removed: 'breaking',
  guard_removed: 'breaking',
  record_removed: 'breaking',
  message_removed: 'breaking',
  route_added: 'notable',
  journey_changed: 'notable',
  record_columns_changed: 'notable',
  rule_removed: 'notable',
  guard_added: 'info',
  record_added: 'info',
  message_added: 'info',
  rule_added: 'info',
  edge_confidence_changed: 'info',
  node_renamed: 'info',
  coverage_lost: 'notable',
  test_removed: 'notable',
  test_added: 'info',
  uncovered_change: 'info',
};

export interface DiffOptions {
  /** max changes carried in `changes` (counts stay complete). Default 500. */
  limit?: number;
  /** precomputed row changes (SnapshotDb.changedBetween) — the SQL path; computed from the stores when absent. */
  changes?: { nodes: RowChange[]; edges: RowChange[] };
}

// ── internals ──────────────────────────────────────────────────────────────

/** Kinds whose add/remove maps to a first-class ChangeKind (everything else is code, not surface). */
const SURFACE_ADD: Partial<Record<NodeKind, ChangeKind>> = {
  route: 'route_added', table: 'record_added', queue: 'message_added', rule: 'rule_added', test: 'test_added',
};
const SURFACE_REMOVE: Partial<Record<NodeKind, ChangeKind>> = {
  route: 'route_removed', table: 'record_removed', queue: 'message_removed', rule: 'rule_removed', test: 'test_removed',
};
/** Kinds whose loss of every test is worth reporting: the surfaces a person can name. */
const COVERAGE_SURFACES = new Set<NodeKind>(['route', 'flow', 'page']);
/** Kinds an `uncovered_change` can fire on — a body changed and nothing verifies it. */
const COVERABLE_KINDS = new Set<NodeKind>(['function', 'component', 'page', 'route', 'guard', 'rule']);
/** Kinds eligible for the same-location rename pairing (kinds without their own add/remove semantics). */
const RENAMEABLE = new Set<NodeKind>(['function', 'component', 'class', 'page', 'module', 'file']);

function refLabel(meta: GraphMeta): string {
  const base = meta.sync != null ? `sync:${meta.sync}` : meta.digest ? `digest:${meta.digest}` : 'unknown';
  return meta.commit ? `${base} · ${meta.commit.slice(0, 7)}` : base;
}

/** Fallback row-change computation when no SnapshotDb is available (e.g. two graph.json files). */
export function rowChangesOf(base: GraphStore, head: GraphStore): { nodes: RowChange[]; edges: RowChange[] } {
  const one = <T extends { id: string }>(from: T[], to: T[]): RowChange[] => {
    const a = new Map(from.map((x) => [x.id, JSON.stringify(x)]));
    const b = new Map(to.map((x) => [x.id, JSON.stringify(x)]));
    const changes: RowChange[] = [];
    for (const [key, json] of a) {
      const after = b.get(key);
      if (after === undefined) changes.push({ key, change: 'removed', before: JSON.parse(json) });
      else if (after !== json) changes.push({ key, change: 'changed', before: JSON.parse(json), after: JSON.parse(after) });
    }
    for (const [key, json] of b) {
      if (!a.has(key)) changes.push({ key, change: 'added', after: JSON.parse(json) });
    }
    changes.sort((x, y) => x.key.localeCompare(y.key));
    return changes;
  };
  const bg = base.toJSON();
  const hg = head.toJSON();
  return { nodes: one(bg.nodes, hg.nodes), edges: one(bg.edges, hg.edges) };
}

interface Candidate {
  kind: ChangeKind;
  subject: DiffChange['subject'];
  journey?: DiffChange['journey'];
  loc?: Loc;
  confidence: DiffChange['confidence'];
  technique?: ResolutionTechnique;
  /** deterministic tiebreaker beyond kind+subject (edge key, journey id, …) */
  detail: string;
  contractStatus?: DiffChange['contractStatus'];
}

/** Journey identity of an entry: the ordered hop sequence (via:nodeId). Structural, not textual. */
function journeySignature(index: ReturnType<typeof buildIndex>, entryId: string): string {
  // planned steps are contract intent, not hops: a spec edit must not read as an execution-path change
  return journey(index, entryId).steps.filter((s) => s.via !== 'planned').map((s) => `${s.via}:${s.nodeId}`).join('→');
}

type ContractStatusLabel = NonNullable<DiffChange['contractStatus']>['from'];

/** A route's contract status for the planned → built transition; 'none' when it has no contract. */
function contractStatusOf(n: GraphNode | undefined): ContractStatusLabel {
  return n?.contract?.status ?? 'none';
}

// ── the contract functions ─────────────────────────────────────────────────

/**
 * Compare two graph snapshots into a farsight-diff v1 document. Built on the
 * snapshot store's `changedBetween()` rows when provided (`opts.changes`);
 * falls back to comparing the stores directly (fixtures, degraded mode).
 */
export function diffGraphs(base: GraphStore, head: GraphStore, opts: DiffOptions = {}): GraphDiff {
  const limit = opts.limit ?? 500;
  const rows = opts.changes ?? rowChangesOf(base, head);
  const baseGraph = base.toJSON();
  const headGraph = head.toJSON();
  const baseIndex = buildIndex(baseGraph.nodes, baseGraph.edges);
  const headIndex = buildIndex(headGraph.nodes, headGraph.edges);

  const candidates: Candidate[] = [];
  const subjectOf = (n: GraphNode): DiffChange['subject'] => ({ id: n.id, kind: n.kind, name: n.name });

  // ── node rows ──
  const removedNodes: GraphNode[] = [];
  const addedNodes: GraphNode[] = [];
  for (const rc of rows.nodes) {
    if (rc.change === 'added') {
      const n = rc.after as GraphNode;
      addedNodes.push(n);
      const kind = SURFACE_ADD[n.kind];
      if (kind) candidates.push({ kind, subject: subjectOf(n), loc: n.loc, confidence: 'resolved', detail: n.id });
    } else if (rc.change === 'removed') {
      const n = rc.before as GraphNode;
      removedNodes.push(n);
      const kind = SURFACE_REMOVE[n.kind];
      if (kind) candidates.push({ kind, subject: subjectOf(n), loc: n.loc, confidence: 'resolved', detail: n.id });
    } else {
      const before = rc.before as GraphNode;
      const after = rc.after as GraphNode;
      if (after.kind === 'table' && before.signature !== after.signature) {
        candidates.push({ kind: 'record_columns_changed', subject: subjectOf(after), loc: after.loc, confidence: 'resolved', detail: after.id });
      }
      if (before.name !== after.name) {
        candidates.push({ kind: 'node_renamed', subject: subjectOf(after), loc: after.loc, confidence: 'resolved', detail: `${before.name}→${after.name}` });
      }
    }
  }

  // rename pairing (no fingerprints yet — PLANNED in the contract): a removed
  // and an added node of the same non-surface kind at the same file:line is a
  // rename, not churn.
  for (const gone of removedNodes) {
    if (!RENAMEABLE.has(gone.kind) || !gone.loc) continue;
    const twin = addedNodes.find(
      (n) => n.kind === gone.kind && n.loc && n.loc.repo === gone.loc!.repo && n.loc.path === gone.loc!.path && n.loc.line === gone.loc!.line && n.name !== gone.name,
    );
    if (twin) {
      candidates.push({ kind: 'node_renamed', subject: subjectOf(twin), loc: twin.loc, confidence: 'resolved', detail: `${gone.name}→${twin.name}` });
    }
  }

  // ── edge rows ──
  for (const rc of rows.edges) {
    const edge = (rc.after ?? rc.before) as GraphEdge;
    if (edge.kind === 'guards' && (rc.change === 'added' || rc.change === 'removed')) {
      // subject = the protected node: "which endpoint gained/lost a gate" is the audit question
      const graphIdx = rc.change === 'added' ? headIndex : baseIndex;
      const target = graphIdx.byId.get(edge.to);
      const guardName = (rc.change === 'added' ? headIndex : baseIndex).byId.get(edge.from)?.name ?? edge.from;
      if (target) {
        candidates.push({
          kind: rc.change === 'added' ? 'guard_added' : 'guard_removed',
          subject: subjectOf(target),
          loc: target.loc,
          confidence: edge.resolution?.confidence ?? 'resolved',
          ...(edge.resolution ? { technique: edge.resolution.technique } : {}),
          detail: `${guardName}|${rc.key}`,
        });
      }
    }
    if (rc.change === 'changed') {
      const before = rc.before as GraphEdge;
      const after = rc.after as GraphEdge;
      if (before.resolution?.confidence !== after.resolution?.confidence && (before.resolution || after.resolution)) {
        const target = headIndex.byId.get(after.to);
        if (target) {
          candidates.push({
            kind: 'edge_confidence_changed',
            subject: subjectOf(target),
            loc: target.loc,
            confidence: after.resolution?.confidence ?? 'resolved',
            ...(after.resolution ? { technique: after.resolution.technique } : {}),
            detail: rc.key,
          });
        }
      }
    }
  }

  // ── tests: what lost its last test, and what changed with nothing verifying it ──
  // (additive kinds; see docs/contracts/farsight-diff-v1.md "Version note 2026-09")
  const coversOf = (idx: typeof headIndex, id: string) => (idx.in.get(id) ?? []).filter((e) => e.kind === 'covers').length;
  const headHasTests = [...headIndex.byId.values()].some((n) => n.kind === 'test');
  const lostCoverage = new Set<string>();
  for (const rc of rows.edges) {
    const edge = (rc.after ?? rc.before) as GraphEdge;
    if (edge.kind !== 'covers' || rc.change !== 'removed') continue;
    if (lostCoverage.has(edge.to)) continue;
    const target = headIndex.byId.get(edge.to);
    // gone entirely is `route_removed`, not a coverage loss; a target that still exists
    // and now has no covers edge at all is the finding
    if (!target || !COVERAGE_SURFACES.has(target.kind)) continue;
    if (coversOf(headIndex, edge.to) > 0 || coversOf(baseIndex, edge.to) === 0) continue;
    lostCoverage.add(edge.to);
    candidates.push({
      kind: 'coverage_lost', subject: subjectOf(target), loc: target.loc,
      confidence: edge.resolution?.confidence ?? 'resolved',
      ...(edge.resolution ? { technique: edge.resolution.technique } : {}),
      detail: edge.to,
    });
  }
  if (headHasTests) {
    for (const rc of rows.nodes) {
      if (rc.change !== 'changed') continue;
      const before = rc.before as GraphNode;
      const after = rc.after as GraphNode;
      if (!COVERABLE_KINDS.has(after.kind)) continue;
      // a real body change, not a re-tag or a moved line
      const moved = before.signature !== after.signature || before.snippet !== after.snippet
        || JSON.stringify(before.branches ?? []) !== JSON.stringify(after.branches ?? []);
      if (!moved || coversOf(headIndex, after.id) > 0) continue;
      candidates.push({
        kind: 'uncovered_change', subject: subjectOf(after), loc: after.loc,
        confidence: 'resolved', detail: after.id,
      });
    }
  }

  // ── journeys: structural hop-sequence comparison for entries present in both graphs ──
  // (the plan's journeySummary() lands in P5; until then the hop sequence of
  // journey() is the structural identity — noted in the contract doc)
  const isEntry = (n: GraphNode) => n.kind === 'route' || n.tags.includes('entrypoint');
  for (const n of headGraph.nodes) {
    if (!isEntry(n) || !baseIndex.byId.has(n.id)) continue;
    if (journeySignature(baseIndex, n.id) !== journeySignature(headIndex, n.id)) {
      const from = contractStatusOf(baseIndex.byId.get(n.id));
      const to = contractStatusOf(n);
      candidates.push({
        kind: 'journey_changed',
        subject: subjectOf(n),
        journey: { id: n.id, name: n.facets?.business?.label ?? n.name },
        loc: n.loc,
        confidence: 'resolved',
        detail: n.id,
        ...(from !== to ? { contractStatus: { from, to } } : {}),
      });
    }
  }

  // ── deterministic order → stable ids ──
  const kindIndex = new Map(CHANGE_KINDS.map((k, i) => [k, i]));
  candidates.sort((a, b) =>
    kindIndex.get(a.kind)! - kindIndex.get(b.kind)! ||
    a.subject.id.localeCompare(b.subject.id) ||
    a.detail.localeCompare(b.detail),
  );

  const counts = Object.fromEntries(CHANGE_KINDS.map((k) => [k, 0])) as Record<ChangeKind, number>;
  for (const c of candidates) counts[c.kind]++;

  const baseSync = base.meta.sync ?? 'x';
  const headSync = head.meta.sync ?? 'x';
  const truncated = candidates.length > limit;
  const changes: DiffChange[] = candidates.slice(0, limit).map((c, i) => ({
    id: `c${i + 1}`,
    kind: c.kind,
    severity: SEVERITY[c.kind],
    confidence: c.confidence,
    ...(c.technique ? { technique: c.technique } : {}),
    subject: c.subject,
    ...(c.journey ? { journey: c.journey } : {}),
    ...(c.loc ? { loc: c.loc } : {}),
    permalink: `/compare/${baseSync}...${headSync}#c${i + 1}`,
    ...(c.contractStatus ? { contractStatus: c.contractStatus } : {}),
  }));

  return {
    schema: 'farsight-diff v1',
    base: refLabel(base.meta),
    head: refLabel(head.meta),
    truncated,
    counts,
    changes,
  };
}

// ── policy: facts in the diff, judgment in compliance.yml ─────────────────

export interface PolicyRule {
  rule: string;
  /** a ChangeKind, `severity:<breaking|notable|info>`, or `any` */
  when: string;
  then: 'fail' | 'warn' | 'allow';
}

export interface PolicyFile {
  version: number;
  /** display name for the gate block — usually the file path */
  name?: string;
  rules: PolicyRule[];
}

/**
 * Parse the minimal compliance.yml subset (documented in the contract doc §
 * "Policy file format"). Deliberately not a YAML library: flat `key: value`
 * pairs, a `rules:` list of `- key: value` items, `#` comments. Anything
 * fancier is a parse error, on purpose.
 */
export function parsePolicy(text: string, name?: string): PolicyFile {
  const policy: PolicyFile = { version: 1, ...(name ? { name } : {}), rules: [] };
  let inRules = false;
  let current: Partial<PolicyRule> | null = null;
  const commit = () => {
    if (!current) return;
    const { rule, when, then } = current;
    if (!rule || !when || !then) throw new Error(`compliance policy: rule needs rule/when/then (got ${JSON.stringify(current)})`);
    if (!['fail', 'warn', 'allow'].includes(then)) throw new Error(`compliance policy: then must be fail|warn|allow (got "${then}")`);
    policy.rules.push({ rule, when, then });
    current = null;
  };
  for (const raw of text.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const line = raw.replace(/\t/g, '  ');
    const item = line.match(/^\s*-\s+(\w+):\s*(.+?)\s*$/);
    const kv = line.match(/^(\s*)(\w+):\s*(.*?)\s*$/);
    const unquote = (v: string) => v.replace(/^['"]|['"]$/g, '');
    if (item) {
      if (!inRules) throw new Error(`compliance policy: list item outside rules: ${raw.trim()}`);
      commit();
      current = { [item[1]!]: unquote(item[2]!) } as Partial<PolicyRule>;
    } else if (kv) {
      const [, indent, key, value] = kv;
      if (indent && current) {
        (current as Record<string, string>)[key!] = unquote(value!);
      } else if (key === 'version') {
        commit();
        inRules = false;
        policy.version = Number(value);
      } else if (key === 'rules' && value === '') {
        commit();
        inRules = true;
      } else {
        throw new Error(`compliance policy: unsupported line (see the format subset in docs/contracts/farsight-diff-v1.md): ${raw.trim()}`);
      }
    } else {
      throw new Error(`compliance policy: cannot parse line: ${raw.trim()}`);
    }
  }
  commit();
  if (policy.version !== 1) throw new Error(`compliance policy: unsupported version ${policy.version} (this build understands 1)`);
  return policy;
}

function ruleMatches(when: string, change: DiffChange): boolean {
  if (when === 'any') return true;
  const sev = when.match(/^severity:\s*(breaking|notable|info)$/);
  if (sev) return change.severity === sev[1];
  return change.kind === when;
}

/** Apply a policy to a diff → the same diff with a `gate` verdict (immutable; the input is untouched). */
export function applyPolicy(diff: GraphDiff, policy: PolicyFile): GraphDiff {
  const rules = policy.rules.map((r) => {
    const matched = diff.changes.filter((c) => ruleMatches(r.when, c));
    const result = matched.length === 0 ? 'pass' : r.then === 'fail' ? 'fail' : r.then === 'warn' ? 'warn' : 'allow';
    return { rule: r.rule, result, changes: matched.map((c) => c.id) };
  });
  const failed = rules.some((r) => r.result === 'fail');
  return {
    ...diff,
    gate: { policy: policy.name ?? 'compliance.yml', result: failed ? 'fail' : 'pass', exit: failed ? 1 : 0, rules },
  };
}

// ── renderers ──────────────────────────────────────────────────────────────

const SENTENCES: Record<ChangeKind, (c: DiffChange) => string> = {
  route_added: (c) => `route added: ${c.subject.name}`,
  route_removed: (c) => `route removed: ${c.subject.name}`,
  guard_added: (c) => `permission gate added on ${c.subject.name} (${c.subject.kind})`,
  guard_removed: (c) => `permission gate removed from ${c.subject.name} (${c.subject.kind})`,
  journey_changed: (c) => {
    const cs = c.contractStatus;
    if (cs && (cs.from === 'spec-only' || cs.from === 'declared') && cs.to === 'both') return `journey built: ${c.journey?.name ?? c.subject.name} — planned → built, the declared operation now runs code`;
    if (cs && cs.from === 'both' && (cs.to === 'spec-only' || cs.to === 'declared')) return `journey unbuilt: ${c.journey?.name ?? c.subject.name} — built → planned, the implementation is gone and only the contract remains`;
    return `journey changed: ${c.journey?.name ?? c.subject.name} — the execution path is not what it was`;
  },
  record_added: (c) => `record added: ${c.subject.name}`,
  record_removed: (c) => `record removed: ${c.subject.name}`,
  record_columns_changed: (c) => `record columns changed: ${c.subject.name}`,
  message_added: (c) => `message topic added: ${c.subject.name}`,
  message_removed: (c) => `message topic removed: ${c.subject.name}`,
  rule_added: (c) => `validation rule added: ${c.subject.name}`,
  rule_removed: (c) => `validation rule removed: ${c.subject.name}`,
  edge_confidence_changed: (c) => `edge confidence changed on ${c.subject.name}: now ${c.confidence}`,
  node_renamed: (c) => `renamed: now ${c.subject.name}`,
  test_added: (c) => `test added: ${c.subject.name}`,
  test_removed: (c) => `test removed: ${c.subject.name}`,
  coverage_lost: (c) => `no test covers ${c.subject.name} (${c.subject.kind}) any more — it had at least one before`,
  uncovered_change: (c) => `changed with nothing verifying it: ${c.subject.name} (${c.subject.kind})`,
};

export function changeSentence(change: DiffChange): string {
  return SENTENCES[change.kind](change);
}

const SARIF_LEVEL: Record<DiffChange['severity'], string> = { breaking: 'error', notable: 'warning', info: 'note' };

/** SARIF 2.1.0 rendering — one result per change, ruleId = ChangeKind. */
export function toSarif(diff: GraphDiff): object {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'farsight',
            informationUri: 'https://github.com/farsight/farsight',
            rules: CHANGE_KINDS.map((k) => ({ id: k, shortDescription: { text: k.replace(/_/g, ' ') } })),
          },
        },
        properties: { schema: diff.schema, base: diff.base, head: diff.head, truncated: diff.truncated },
        results: diff.changes.map((c) => ({
          ruleId: c.kind,
          level: SARIF_LEVEL[c.severity],
          message: { text: `${changeSentence(c)} [confidence: ${c.confidence}]` },
          ...(c.loc
            ? {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: c.loc.path },
                      region: { startLine: c.loc.line },
                    },
                  },
                ],
              }
            : {}),
          partialFingerprints: { changeId: c.id, subjectId: c.subject.id },
        })),
      },
    ],
  };
}

/** Markdown rendering — `farsight diff --format md`. */
export function toMarkdown(diff: GraphDiff): string {
  const lines: string[] = [];
  lines.push(`# farsight diff — ${diff.base} → ${diff.head}`);
  lines.push('');
  const nonzero = CHANGE_KINDS.filter((k) => diff.counts[k] > 0);
  if (!nonzero.length) {
    lines.push('No contract-level changes.');
    return lines.join('\n') + '\n';
  }
  lines.push('| change | count |', '| --- | ---: |');
  for (const k of nonzero) lines.push(`| ${k} | ${diff.counts[k]} |`);
  lines.push('');
  for (const severity of ['breaking', 'notable', 'info'] as const) {
    const group = diff.changes.filter((c) => c.severity === severity);
    if (!group.length) continue;
    lines.push(`## ${severity}`);
    for (const c of group) {
      const at = c.loc ? ` — \`${c.loc.path}:${c.loc.line}\`` : '';
      lines.push(`- **${c.id}** ${changeSentence(c)}${at} _(confidence: ${c.confidence})_`);
    }
    lines.push('');
  }
  if (diff.truncated) lines.push('> truncated: change list cut at the limit — counts above are complete.');
  if (diff.gate) {
    lines.push(`## gate — ${diff.gate.result.toUpperCase()} (${diff.gate.policy})`);
    for (const r of diff.gate.rules) {
      lines.push(`- ${r.result === 'fail' ? '✗' : r.result === 'warn' ? '⚠' : '✓'} ${r.rule}: ${r.result}${r.changes.length ? ` (${r.changes.join(', ')})` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}
