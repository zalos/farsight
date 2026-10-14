/**
 * Switches (lane moves, 2026-10-13, worklist F9): the module-level constants a branch tests before a call — read
 * from the `calls` edges the parser stamped with `meta.whenFlag` (parsers/src/flag-gates.ts), never a hand-kept list.
 * Each switch: its name, its literal value, where it is declared, the calls it decides and whether it stops any of
 * them. One fold per index; every number a `Counted` (docs/COUNTS.md § Switches).
 */
import type { GraphNode } from './graph.js';
import type { GraphIndex } from './query.js';
import { counted, type Counted } from './counts.js';
import { t, type Register } from './strings.js';
import { movesByWriter } from './gates.js';

export interface SwitchCall { from: string; to: string; line?: number; inactive: boolean }
export interface Switch {
  flag: string;
  value: boolean;
  /** `path:line` of the declaration */
  at: string;
  repo: string;
  /** at least one call it decides does not run */
  off: boolean;
  calls: SwitchCall[];
  counted: Counted;
}
export interface SwitchesAnswer { switches: Switch[]; counted: Counted }

const SRC = 'core/switches.ts switchesOf · edges[].meta.whenFlag';
const CACHE = new WeakMap<GraphIndex, Switch[]>();

function fold(index: GraphIndex): Switch[] {
  const hit = CACHE.get(index);
  if (hit) return hit;
  const by = new Map<string, Switch>();
  for (const list of index.out.values()) {
    for (const e of list) {
      if (e.kind !== 'calls' || typeof e.meta?.whenFlag !== 'string') continue;
      const at = typeof e.meta.whenAt === 'string' ? e.meta.whenAt : '';
      const repo = e.from.split('::')[0]!;
      const k = `${repo}|${e.meta.whenFlag}|${at}`;
      let s = by.get(k);
      if (!s) {
        s = { flag: e.meta.whenFlag, value: e.meta.whenValue === true, at, repo, off: false, calls: [], counted: undefined as unknown as Counted };
        by.set(k, s);
      }
      const inactive = e.meta.inactive === true;
      if (inactive) s.off = true;
      if (!s.calls.some((c) => c.from === e.from && c.to === e.to)) s.calls.push({ from: e.from, to: e.to, ...(typeof e.meta.line === 'number' ? { line: e.meta.line } : {}), inactive });
    }
  }
  const out = [...by.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.at.localeCompare(b.at) || a.flag.localeCompare(b.flag));
  for (const s of out) {
    const off = s.calls.filter((c) => c.inactive).length;
    s.counted = counted(s.calls.length, 'switch.calls', 'count.scope.node', `${SRC} → calls under ${s.flag}`, {
      breakdown: [{ key: 'count.part.switchCallsOff', n: off }, { key: 'count.part.switchCallsOn', n: s.calls.length - off }],
    });
  }
  CACHE.set(index, out);
  return out;
}

/** Every switch, in one source or all; the count over the source(s). */
export function switchesOf(index: GraphIndex, repo?: string): SwitchesAnswer {
  const switches = fold(index).filter((s) => !repo || s.repo === repo);
  const off = switches.filter((s) => s.off).length;
  return {
    switches,
    counted: counted(switches.length, 'count.unit.switches', 'count.scope.source', SRC, {
      bizUnit: 'count.unit.switches',
      breakdown: [{ key: 'count.part.switchesOff', n: off }, { key: 'count.part.switchesOn', n: switches.length - off }],
    }),
  };
}

/** The switches that stop a call to code that moves this record's status: `{flag, writer, caller}` per call. */
export function switchesForRecord(index: GraphIndex, node: GraphNode): { sw: Switch; call: SwitchCall; writer: string }[] {
  if (!node.lifecycle) return [];
  const writers = new Set(node.lifecycle.transitions.map((x) => x.by));
  const byWriter = movesByWriter(index);
  const out: { sw: Switch; call: SwitchCall; writer: string }[] = [];
  for (const sw of fold(index)) {
    for (const c of sw.calls) {
      if (!c.inactive) continue;
      // the switched-off callee, or a writer it calls (two calls deep) that moves this record
      const reach = [c.to, ...(index.out.get(c.to) ?? []).filter((e) => e.kind === 'calls').map((e) => e.to)];
      const w = reach.find((id) => writers.has(id) && (byWriter.get(id) ?? []).some((m) => m.table.id === node.id));
      if (w) out.push({ sw, call: c, writer: w });
    }
  }
  return out;
}

/** The switches that decide calls made from the given nodes (a screen's walk): each once. */
export function switchesFrom(index: GraphIndex, ids: Iterable<string>): Switch[] {
  const set = new Set(ids);
  return fold(index).filter((s) => s.calls.some((c) => set.has(c.from)));
}

const nm = (id: string) => id.split('::').pop() ?? id;

/** One line per switch, for MCP and the CLI. */
export function switchLines(list: Switch[], reg: Register = 'professional'): string[] {
  return list.map((s) => `  ${t('switch.line', reg)
    .replace('{flag}', s.flag).replace('{value}', String(s.value))
    .replace('{state}', t(s.off ? 'switch.offWord' : 'switch.on', reg)).replace('{at}', s.at)
    .replace('{calls}', s.calls.map((c) => `${nm(c.from)} → ${nm(c.to)}${c.inactive ? ` (${t('switch.word', reg)})` : ''}`).join(', '))}`);
}

/** The record's switched-off moves as lines, for `describe_node`. */
export function recordSwitchLines(index: GraphIndex, node: GraphNode, reg: Register = 'professional'): string[] {
  return switchesForRecord(index, node).map(({ sw, call, writer }) => `  ${t('switch.recordLine', reg)
    .replace('{flag}', sw.flag).replace('{value}', String(sw.value)).replace('{writer}', nm(writer)).replace('{caller}', nm(call.from)).replace('{at}', sw.at)}`);
}
