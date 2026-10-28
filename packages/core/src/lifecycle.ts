/**
 * The status lifecycle of a record, as numbers and lines (swarm-fixes round 2026-10-05, finding 7).
 *
 * `GraphNode.lifecycle` is written by the parser (parsers/src/lifecycle.ts): the statuses one field
 * of a record may hold, in declared order, and each move a function performs. This module is the
 * one place its numbers are counted (docs/COUNTS.md § Lifecycle) and the text the CLI and MCP
 * print, so every surface says the same thing about one record.
 */
import type { GraphNode, RecordLifecycle, LifecycleTransition, JourneysMeta } from './graph.js';
import { counted, countedText, type Counted } from './counts.js';
import { t, type Register } from './strings.js';
import { humanizeName, type GraphIndex, type Journey, type JourneySummary } from './query.js';

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
      breakdown: [
        { key: 'lifecycle.part.written', n: written },
        { key: 'lifecycle.part.unwritten', n: unwritten },
      ],
    }),
    transitions: counted(
      life.transitions.length,
      'lifecycle.count.transitions',
      'count.scope.node',
      `${SOURCE}.transitions`,
      {
        bizUnit: 'lifecycle.count.transitions',
        breakdown: [
          { key: 'lifecycle.part.withFrom', n: withFrom },
          { key: 'lifecycle.part.noFrom', n: life.transitions.length - withFrom },
        ],
      },
    ),
    unwritten: counted(
      unwritten,
      'lifecycle.count.unwritten',
      'count.scope.node',
      `${SOURCE}.statuses − transitions[].to`,
      {
        bizUnit: 'lifecycle.count.unwritten',
      },
    ),
  };
}

/** A writer's printable name: the last segment of its node id (`repo::path::name`). */
const nameOfId = (id: string): string => id.split('::').pop() ?? id;

/**
 * The lifecycle as lines of text, for MCP `describe_node` and the CLI: the statuses in order, the
 * moves with their writers (node ids, so an agent can follow them), the statuses nothing writes,
 * and where the list is declared. Empty when the node has no lifecycle.
 */
export function lifecycleLines(
  node: GraphNode,
  opts: { register?: Register; byName?: (id: string) => string | undefined } = {},
): string[] {
  const life = node.lifecycle;
  if (!life) return [];
  const reg = opts.register ?? 'professional';
  const c = lifecycleCounts(life);
  const lines: string[] = [];
  lines.push(
    `${t('lifecycle.word', reg)} · ${t('lifecycle.ofRecord', reg).replace('{name}', node.name).replace('{field}', life.field)}` +
      ` — ${countedText(c.statuses, { register: reg, scope: false })} · ${countedText(c.transitions, { register: reg, scope: false })} · ${countedText(c.unwritten, { register: reg, scope: false })}`,
  );
  lines.push(`  ${life.statuses.join(' · ')}`);
  for (const tr of life.transitions) {
    const move =
      tr.from !== undefined || tr.fromAny?.length
        ? t('lifecycle.move', reg)
            .replace('{from}', tr.from ?? tr.fromAny!.join(t('lifecycle.table.fromOr', reg)))
            .replace('{to}', tr.to)
        : t('lifecycle.moveInto', reg).replace('{to}', tr.to);
    lines.push(
      `  ${move}  ${t('lifecycle.by', reg).replace('{name}', opts.byName?.(tr.by) ?? nameOfId(tr.by))} (${t(`lifecycle.via.${tr.via}`, reg)}) · ${tr.by}${tr.line ? `:${tr.line}` : ''}`,
    );
  }
  const none = unwrittenStatuses(life);
  if (none.length) lines.push(`  ${t('lifecycle.unwritten', reg)}: ${none.join(' · ')}`);
  const where = life.provenance.map((p) => `${p.name ? `${p.name} ` : ''}${p.path}:${p.line}`).join(' · ');
  if (where) lines.push(`  ${t('lifecycle.declaredBy', reg).replace('{where}', where)}`);
  return lines;
}

/** One record a journey reaches whose statuses the code declares, with its numbers and which moves the journey makes. */
export interface JourneyLifecycle {
  /** the record in the words of each persona the journey is for (one view with no persona when it names none) — `lifecycleViews` */
  views?: LifecycleView[];
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
export function journeyLifecycles(
  index: { byId: Map<string, GraphNode> } | GraphIndex,
  j: { steps: { nodeId: string; switchedOff?: unknown }[] },
  opts: {
    personas?: LifecyclePersona[];
    locate?: (writerId: string) => LifecyclePlace | undefined;
    places?: (writerId: string) => LifecyclePlaces;
  } = {},
): JourneyLifecycle[] {
  // a call a constant switches off is named, not run: its writer is not on the journey
  const visited = new Set(j.steps.filter((s) => !s.switchedOff).map((s) => s.nodeId));
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
      nodeId: n.id,
      name: n.name,
      lifecycle: n.lifecycle,
      counts: lifecycleCounts(n.lifecycle),
      onJourney: n.lifecycle.transitions.map((tr) => visited.has(tr.by)),
      writers,
      ...('in' in index ? { views: lifecycleViews(index, n, opts) } : {}),
    });
  }
  return out;
}

// ── one state machine, two views of it (round 2026-10-10 §3) ──────────────────────────────────────
// The code decides the statuses and the moves; `farsight.config.json → lifecycle` only names them, per
// persona (`RecordLifecycle.names`, applied at ingest). A view is one persona's reading of one record:
// each status in declared order with the word that persona uses (config, else `humanizeName`), the
// constant, and what moves a record into it — each writer placed on a journey screen when one is known;
// then the overlays, conditions a person sees that are not a status, as rows of their own kind.

export interface LifecyclePersona {
  id: string;
  name: string;
}
/** Where a writer runs: a journey's screen (1-based ordinal of its summary segment) — the journey link's `step`. */
export interface LifecyclePlace {
  flowId: string;
  flowName: string;
  screen: number;
  screenName: string;
  here: boolean;
  /** the action on that screen whose call reaches the writer, when one does (its label as the moment prints it) */
  action?: string;
  /** how many calls under that action's call the writer runs (0 = the action's call is the writer) */
  hops?: number;
}
/** A place whose action holds the call to the writer under a constant that switches it off. */
export interface LifecycleSwitchedPlace extends LifecyclePlace {
  flag: string;
  value: boolean;
  at: string;
}
/**
 * Every place a writer runs (lane moves, 2026-10-13): the live ones, the action that calls the writer most directly
 * first — never the first place the walk met — and the ones a constant switches off, listed apart.
 */
export interface LifecyclePlaces {
  live: LifecyclePlace[];
  off: LifecycleSwitchedPlace[];
}
export interface LifecycleMover {
  /** node id of the function that writes it */
  by: string;
  /** its name as the code spells it */
  name: string;
  /** its name in words: the glossary's, else the name humanized */
  words: string;
  /** how it writes; `writes` for an overlay table's writer */
  via: LifecycleTransition['via'] | 'writes';
  from?: string;
  /** the statuses the code lets the record leave for this one, when its writer goes through a table of moves or a check */
  fromAny?: string[];
  line?: number;
  /** the place a surface names: the live action that calls the writer most directly */
  at?: LifecyclePlace;
  /** the other live places that reach the same writer, folded behind *also reached from n* */
  also?: LifecyclePlace[];
  /** places whose call to the writer a constant switches off: *switched off by <flag>*, never the mover */
  switchedOff?: LifecycleSwitchedPlace[];
  /** one arm of a ternary of literal statuses: the condition the code writes it under */
  when?: string;
}
export interface LifecycleStatusRow {
  kind: 'status';
  /** the constant, as the code spells it */
  status: string;
  /** the word the persona uses — from config when `declared`, else the constant humanized */
  word: string;
  declared: boolean;
  /** some code moves a record into it */
  written: boolean;
  movers: LifecycleMover[];
}
export interface LifecycleOverlayRow {
  kind: 'overlay';
  name: string;
  when: string;
  table: string;
  tableId: string;
  tableName: string;
  /** the code that writes the overlay's table */
  movers: LifecycleMover[];
}
export interface LifecycleView {
  persona?: LifecyclePersona;
  /** at least one status carries a word config gave for this persona */
  declared: boolean;
  rows: LifecycleStatusRow[];
  overlays: LifecycleOverlayRow[];
  counts: { statuses: Counted; moved: Counted; unmoved: Counted; overlays: Counted };
  /** the config files the words came from (empty when none applies to this persona) */
  from: string[];
}

const VIEW_SOURCE = 'core/lifecycle.ts lifecycleViews · node.lifecycle';
const keyOf = (s: string) => s.trim().toLowerCase();

/** The persona's words for a record: `names.views` keyed by the persona's id or its name (case ignored). */
function wordsFor(life: RecordLifecycle, persona?: LifecyclePersona): Record<string, string> | undefined {
  const views = life.names?.views;
  if (!views || !persona) return undefined;
  const want = new Set([keyOf(persona.id), keyOf(persona.name)]);
  const hit = Object.keys(views).find((k) => want.has(keyOf(k)));
  return hit ? views[hit] : undefined;
}

type Locate = { locate?: (id: string) => LifecyclePlace | undefined; places?: (id: string) => LifecyclePlaces };
function moverOf(
  index: GraphIndex,
  by: string,
  via: LifecycleMover['via'],
  loc: Locate,
  extra: { from?: string; fromAny?: string[]; line?: number; when?: string } = {},
): LifecycleMover {
  const n = index.byId.get(by);
  const name = n?.name ?? nameOfId(by);
  const all = loc.places?.(by);
  const at = all ? all.live[0] : loc.locate?.(by);
  const also = all?.live.slice(1) ?? [];
  const off = all?.off ?? [];
  return {
    by,
    name,
    words: n?.facets?.business?.label ?? humanizeName((name.split(': ')[0] ?? name).split('.').pop() ?? name),
    via,
    ...(extra.from !== undefined ? { from: extra.from } : {}),
    ...(extra.fromAny?.length ? { fromAny: extra.fromAny } : {}),
    ...(extra.line ? { line: extra.line } : {}),
    ...(at ? { at } : {}),
    ...(also.length ? { also } : {}),
    ...(off.length ? { switchedOff: off } : {}),
    ...(extra.when ? { when: extra.when } : {}),
  };
}

/**
 * One record read by each persona: a view per persona (one with no persona when none is given). Lookups
 * only — the record's own transitions and the overlay tables' incoming `writes` edges.
 */
export function lifecycleViews(
  index: GraphIndex,
  node: GraphNode,
  opts: {
    personas?: LifecyclePersona[];
    locate?: (writerId: string) => LifecyclePlace | undefined;
    places?: (writerId: string) => LifecyclePlaces;
  } = {},
): LifecycleView[] {
  const life = node.lifecycle;
  if (!life) return [];
  const personas: (LifecyclePersona | undefined)[] = opts.personas?.length ? opts.personas : [undefined];
  // the movers are the same for every persona: built once
  const movers = new Map<string, LifecycleMover[]>();
  for (const tr of life.transitions) {
    const list = movers.get(tr.to) ?? [];
    // where the record comes from: the status the writer checks, else the statuses its table of moves or its check lets
    // it leave (swarm round 3: approve requires *under review* and the lifecycle never said *from*)
    if (!list.some((m) => m.by === tr.by))
      list.push(
        moverOf(index, tr.by, tr.via, opts, {
          ...(tr.from !== undefined ? { from: tr.from } : {}),
          ...(tr.fromAny?.length ? { fromAny: tr.fromAny } : {}),
          ...(tr.line ? { line: tr.line } : {}),
          ...(tr.when ? { when: tr.when } : {}),
        }),
      );
    movers.set(tr.to, list);
  }
  // a writer every one of whose places a constant switches off is not what moves the record there: the live movers
  // of a status come first (lane moves, 2026-10-13)
  const offOnly = (m: LifecycleMover) => !m.at && !!m.switchedOff?.length;
  for (const [k, list] of movers) movers.set(k, [...list.filter((m) => !offOnly(m)), ...list.filter(offOnly)]);
  const overlays: LifecycleOverlayRow[] = (life.names?.overlays ?? []).map((o) => {
    const seen = new Set<string>();
    const ms: LifecycleMover[] = [];
    for (const e of index.in.get(o.tableId) ?? []) {
      if (e.kind !== 'writes' || seen.has(e.from)) continue;
      seen.add(e.from);
      ms.push(moverOf(index, e.from, 'writes', opts));
    }
    return {
      kind: 'overlay',
      name: o.name,
      when: o.when,
      table: o.table,
      tableId: o.tableId,
      tableName: index.byId.get(o.tableId)?.name ?? o.table,
      movers: ms,
    };
  });
  return personas.map((persona) => {
    const words = wordsFor(life, persona);
    const rows: LifecycleStatusRow[] = life.statuses.map((status) => {
      const word = words?.[status];
      const ms = movers.get(status) ?? [];
      return {
        kind: 'status',
        status,
        word: word ?? humanizeName(status),
        declared: word !== undefined,
        written: ms.length > 0,
        movers: ms,
      };
    });
    const moved = rows.filter((r) => r.written).length;
    const declared = rows.some((r) => r.declared);
    return {
      ...(persona ? { persona } : {}),
      declared,
      rows,
      overlays,
      counts: {
        statuses: counted(rows.length, 'lifecycle.count.statuses', 'count.scope.node', `${VIEW_SOURCE}.statuses`, {
          bizUnit: 'lifecycle.count.statuses',
          breakdown: [
            { key: 'lifecycle.part.written', n: moved },
            { key: 'lifecycle.part.unwritten', n: rows.length - moved },
          ],
        }),
        moved: counted(
          moved,
          'lifecycle.count.moved',
          'count.scope.node',
          `${VIEW_SOURCE}.statuses ∩ transitions[].to`,
          { bizUnit: 'lifecycle.biz.moved' },
        ),
        unmoved: counted(
          rows.length - moved,
          'lifecycle.count.unwritten',
          'count.scope.node',
          `${VIEW_SOURCE}.statuses − transitions[].to`,
          { bizUnit: 'lifecycle.biz.unmoved' },
        ),
        overlays: counted(
          overlays.length,
          'lifecycle.count.overlays',
          'count.scope.node',
          `${VIEW_SOURCE}.names.overlays`,
          { bizUnit: 'lifecycle.count.overlays' },
        ),
      },
      from: declared || overlays.length ? [...(life.names?.from ?? [])] : [],
    };
  });
}

/**
 * The personas a flow is for, as the journeys meta resolves them: the config's placement first, else the
 * manifest's `persona`; each id matched to a declared persona's id or name (case ignored), else kept as
 * written. Empty for anything that is not a flow, or a flow that names nobody.
 */
export function flowPersonas(
  index: { byId: Map<string, GraphNode> },
  metas: Record<string, JourneysMeta> | undefined,
  flowId: string,
): LifecyclePersona[] {
  const flow = index.byId.get(flowId);
  if (!flow || flow.kind !== 'flow') return [];
  const repo = flowId.split('::')[0]!;
  const meta = metas?.[repo];
  const designId = flow.design?.id ?? flowId.split('::').pop()!;
  const raw = meta?.flows?.[designId]?.persona ?? flow.design?.persona;
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const out: LifecyclePersona[] = [];
  for (const v of list) {
    const p = meta?.personas.find((x) => keyOf(x.id) === keyOf(v) || keyOf(x.name) === keyOf(v));
    const persona = p ? { id: p.id, name: p.name } : { id: v, name: v };
    if (!out.some((x) => x.id === persona.id)) out.push(persona);
  }
  return out;
}

/**
 * Where each writer runs on one journey: the summary segment whose markers name it, else whose steps
 * include it (a function the action reaches). `here` — the journey the reader has open.
 */
export function placeOnJourney(
  flow: { id: string; name: string },
  j: Pick<Journey, 'steps'>,
  summary: Pick<JourneySummary, 'segments'>,
  here = true,
): (writerId: string) => LifecyclePlace | undefined {
  const all = placesOnJourney(flow, j, summary, here);
  return (id) => all(id).live[0];
}

/**
 * Every place on one journey a writer runs (lane moves, 2026-10-13) — never the first the walk met. Live places:
 * each action whose move the writer makes, the one that calls it most directly first (fewest calls under the
 * action's call), then journey order; else each screen whose markers or walked steps name it. Switched-off places:
 * each action whose call to the writer a constant switches off. A lead segment with no screen folds into the next
 * screen, as the street draws it; one place per screen and action.
 */
export function placesOnJourney(
  flow: { id: string; name: string },
  j: Pick<Journey, 'steps'>,
  summary: Pick<JourneySummary, 'segments'>,
  here = true,
): (writerId: string) => LifecyclePlaces {
  const cache = new Map<string, LifecyclePlaces>();
  const shown = (seg: JourneySummary['segments'][number]) =>
    seg.screen ? seg : (summary.segments.find((sg) => sg.index > seg.index && sg.screen) ?? seg);
  const place = (
    seg: JourneySummary['segments'][number],
    extra: { action?: string; hops?: number } = {},
  ): LifecyclePlace => {
    const sg = shown(seg);
    return {
      flowId: flow.id,
      flowName: flow.name,
      screen: sg.index + 1,
      screenName: sg.screen?.name ?? '',
      here,
      ...(extra.action ? { action: extra.action } : {}),
      ...(extra.hops != null ? { hops: extra.hops } : {}),
    };
  };
  return (id) => {
    const hit = cache.get(id);
    if (hit) return hit;
    const live: LifecyclePlace[] = [];
    const off: LifecycleSwitchedPlace[] = [];
    const keyOf = (p: LifecyclePlace) => `${p.screen}|${p.action ?? ''}`;
    for (const sg of summary.segments) {
      for (const mo of sg.moments ?? []) {
        const mv = mo.preconditions?.moves.filter((m) => m.by === id) ?? [];
        if (mv.length) live.push(place(sg, { action: mo.label, hops: Math.min(...mv.map((m) => m.hops ?? 0)) }));
        const so = mo.preconditions?.switchedOff?.find((m) => m.by === id);
        if (so && !mv.length)
          off.push({
            ...place(sg, { action: mo.label, hops: so.hops ?? 0 }),
            flag: so.flag,
            value: so.value,
            at: so.at,
          });
      }
    }
    if (!live.length) {
      // a writer whose record the action does not reach as a walked step: the screens that name or walk it
      const orders = j.steps.filter((s) => s.nodeId === id && !s.switchedOff).map((s) => s.order);
      for (const sg of summary.segments) {
        if (sg.markers.some((m) => m.nodeId === id) || orders.some((o) => o >= sg.from && o <= sg.to))
          live.push(place(sg));
      }
    }
    const order = (a: LifecyclePlace, b: LifecyclePlace) => (a.hops ?? 99) - (b.hops ?? 99) || a.screen - b.screen;
    const dedupe = <T extends LifecyclePlace>(xs: T[]): T[] => {
      const seen = new Set<string>();
      return xs.filter((p) => !seen.has(keyOf(p)) && !!seen.add(keyOf(p)));
    };
    // a switched-off call is one fact per action, however many screens show that action
    const offs = off
      .sort(order)
      .filter((p, i, xs) => xs.findIndex((q) => q.action === p.action && q.flag === p.flag) === i);
    const out = { live: dedupe(live.sort(order)), off: offs };
    cache.set(id, out);
    return out;
  };
}

/** The view as lines, for MCP `describe_node`: one line per persona view whose words config gave, and the overlays. */
export function lifecycleViewLines(views: LifecycleView[], reg: Register = 'professional'): string[] {
  const out: string[] = [];
  for (const v of views) {
    if (!v.declared) continue;
    const who = v.persona?.name ?? '';
    out.push(
      `  ${t('lifecycle.view.line', reg).replace('{persona}', who)}: ${v.rows.map((r) => `${r.word} (${r.status})`).join(' · ')}`,
    );
  }
  const ov = views[0]?.overlays ?? [];
  for (const o of ov)
    out.push(
      `  ${t('lifecycle.overlay.word', reg)}: ${o.name} — ${o.when} · ${o.tableName}${o.movers.length ? ` · ${t('lifecycle.by', reg).replace('{name}', o.movers.map((m) => m.name).join(', '))}` : ''}`,
    );
  return out;
}
