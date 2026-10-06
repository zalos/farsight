/**
 * The status lifecycle of a record, as numbers and lines (swarm-fixes round 2026-10-05, finding 7).
 *
 * `GraphNode.lifecycle` is written by the parser (parsers/src/lifecycle.ts): the statuses one field
 * of a record may hold, in declared order, and each move a function performs. This module is the
 * one place its numbers are counted (docs/COUNTS.md § Lifecycle) and the text the CLI and MCP
 * print, so every surface says the same thing about one record.
 */
import type { GraphNode, RecordLifecycle } from './graph.js';
import { counted, countedText, type Counted } from './counts.js';
import { t, type Register } from './strings.js';

export interface LifecycleCounts {
  /** the declared statuses, split into those some code moves to and those none does */
  statuses: Counted;
  /** the moves with a writer, split into those whose writer checks the prior status and those that do not */
  transitions: Counted;
  /** the declared statuses no code writes */
  unwritten: Counted;
}

const SOURCE = 'core/lifecycle.ts lifecycleCounts · node.lifecycle';

/** The statuses some code writes, in declared order. */
export function writtenStatuses(life: RecordLifecycle): string[] {
  const to = new Set(life.transitions.map((x) => x.to));
  return life.statuses.filter((s) => to.has(s));
}

/** The declared statuses no code writes, in declared order. */
export function unwrittenStatuses(life: RecordLifecycle): string[] {
  const to = new Set(life.transitions.map((x) => x.to));
  return life.statuses.filter((s) => !to.has(s));
}

/** The three numbers of one record's lifecycle, each a `Counted` over that one node. */
export function lifecycleCounts(life: RecordLifecycle): LifecycleCounts {
  const written = writtenStatuses(life).length;
  const unwritten = life.statuses.length - written;
  const withFrom = life.transitions.filter((x) => x.from !== undefined).length;
  return {
    statuses: counted(life.statuses.length, 'lifecycle.count.statuses', 'count.scope.node', `${SOURCE}.statuses`, {
      bizUnit: 'lifecycle.count.statuses',
      breakdown: [{ key: 'lifecycle.part.written', n: written }, { key: 'lifecycle.part.unwritten', n: unwritten }],
    }),
    transitions: counted(life.transitions.length, 'lifecycle.count.transitions', 'count.scope.node', `${SOURCE}.transitions`, {
      bizUnit: 'lifecycle.count.transitions',
      breakdown: [{ key: 'lifecycle.part.withFrom', n: withFrom }, { key: 'lifecycle.part.noFrom', n: life.transitions.length - withFrom }],
    }),
    unwritten: counted(unwritten, 'lifecycle.count.unwritten', 'count.scope.node', `${SOURCE}.statuses − transitions[].to`, {
      bizUnit: 'lifecycle.count.unwritten',
    }),
  };
}

/** A writer's printable name: the last segment of its node id (`repo::path::name`). */
const nameOfId = (id: string): string => id.split('::').pop() ?? id;

/**
 * The lifecycle as lines of text, for MCP `describe_node` and the CLI: the statuses in order, the
 * moves with their writers (node ids, so an agent can follow them), the statuses nothing writes,
 * and where the list is declared. Empty when the node has no lifecycle.
 */
export function lifecycleLines(node: GraphNode, opts: { register?: Register; byName?: (id: string) => string | undefined } = {}): string[] {
  const life = node.lifecycle;
  if (!life) return [];
  const reg = opts.register ?? 'professional';
  const c = lifecycleCounts(life);
  const lines: string[] = [];
  lines.push(`${t('lifecycle.word', reg)} · ${t('lifecycle.ofRecord', reg).replace('{name}', node.name).replace('{field}', life.field)}`
    + ` — ${countedText(c.statuses, { register: reg, scope: false })} · ${countedText(c.transitions, { register: reg, scope: false })} · ${countedText(c.unwritten, { register: reg, scope: false })}`);
  lines.push(`  ${life.statuses.join(' · ')}`);
  for (const tr of life.transitions) {
    const move = tr.from !== undefined
      ? t('lifecycle.move', reg).replace('{from}', tr.from).replace('{to}', tr.to)
      : t('lifecycle.moveInto', reg).replace('{to}', tr.to);
    lines.push(`  ${move}  ${t('lifecycle.by', reg).replace('{name}', opts.byName?.(tr.by) ?? nameOfId(tr.by))} (${t(`lifecycle.via.${tr.via}`, reg)}) · ${tr.by}${tr.line ? `:${tr.line}` : ''}`);
  }
  const none = unwrittenStatuses(life);
  if (none.length) lines.push(`  ${t('lifecycle.unwritten', reg)}: ${none.join(' · ')}`);
  const where = life.provenance.map((p) => `${p.name ? `${p.name} ` : ''}${p.path}:${p.line}`).join(' · ');
  if (where) lines.push(`  ${t('lifecycle.declaredBy', reg).replace('{where}', where)}`);
  return lines;
}

/** One record a journey reaches whose statuses the code declares, with its numbers and which moves the journey makes. */
export interface JourneyLifecycle {
  nodeId: string;
  name: string;
  lifecycle: RecordLifecycle;
  counts: LifecycleCounts;
  /** per transition, aligned by index: is its writer a step of this journey */
  onJourney: boolean[];
  /** writer node id → its name, so a surface prints a name without a second lookup */
  writers: Record<string, string>;
}

/**
 * The records a journey walk reaches that carry a lifecycle, in the order the walk first meets
 * them. Lookups only — one pass over the steps.
 */
export function journeyLifecycles(index: { byId: Map<string, GraphNode> }, j: { steps: { nodeId: string }[] }): JourneyLifecycle[] {
  const visited = new Set(j.steps.map((s) => s.nodeId));
  const out: JourneyLifecycle[] = [];
  const seen = new Set<string>();
  for (const s of j.steps) {
    if (seen.has(s.nodeId)) continue;
    seen.add(s.nodeId);
    const n = index.byId.get(s.nodeId);
    if (!n?.lifecycle) continue;
    const writers: Record<string, string> = {};
    for (const tr of n.lifecycle.transitions) writers[tr.by] = index.byId.get(tr.by)?.name ?? nameOfId(tr.by);
    out.push({
      nodeId: n.id, name: n.name, lifecycle: n.lifecycle, counts: lifecycleCounts(n.lifecycle),
      onJourney: n.lifecycle.transitions.map((tr) => visited.has(tr.by)), writers,
    });
  }
  return out;
}
