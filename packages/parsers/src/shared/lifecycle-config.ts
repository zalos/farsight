/**
 * `farsight.config.json → lifecycle` applied to the records the code gave a lifecycle (round 2026-10-10 §3).
 *
 * The code decides which statuses a record has and what moves it between them (parsers/src/lifecycle.ts);
 * a config file only names them. For each record the block keys (by node id or table name), every
 * `views[persona][word]` status the code declares gets that word for that persona, and every overlay
 * whose table the graph has is kept with the table's node id. Anything config names that the code does
 * not have — a record, a status, a table — is a note, never a fact on the graph.
 *
 * Nested files scope like every other block: a nested file's entry names only records whose statuses
 * are declared under its folder; files apply root first and by depth, so for one persona and status the
 * nearer file's word stands (a `lifecycle` conflict records the disagreement).
 */
import type { GraphNode, LifecycleNames, LifecycleConfigEntry } from '@farsight/core';
import { recordConflict, type WorkspaceConfig } from './config-files.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Is `path` (repo-relative) inside folder `dir` (`'.'` holds every path)? */
const under = (path: string | undefined, dir: string) => dir === '.' || (!!path && path.replace(/\\/g, '/').startsWith(`${dir}/`));

/**
 * Put each config file's `lifecycle` block on the table nodes it names, in place. Returns how many records
 * carry names afterwards. Notes and conflicts go on `ws.meta`.
 */
export function applyLifecycleConfig(nodes: GraphNode[], ws: WorkspaceConfig): number {
  const notes = ws.meta.notes;
  const tables = nodes.filter((n) => n.kind === 'table');
  if (!ws.files.some((f) => f.config.lifecycle)) return 0;
  const match = (key: string) => tables.filter((n) => n.id === key || n.name === key);
  // persona · status of a record → the file whose word stands
  const setBy = new Map<string, string>();
  const named = new Set<GraphNode>();

  for (const f of ws.files) {
    const block = f.config.lifecycle;
    if (block === undefined) continue;
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      notes.push(`${f.path} → lifecycle is not an object of records; it was not applied.`);
      continue;
    }
    for (const [key, raw] of Object.entries(block as Record<string, LifecycleConfigEntry>)) {
      const where = `${f.path} → lifecycle.${key}`;
      if (!raw || typeof raw !== 'object') { notes.push(`${where} is not an object; it was not applied.`); continue; }
      const found = match(key);
      if (!found.length) { notes.push(`${where} names no record the code has; it was not applied.`); continue; }
      const withLife = found.filter((n) => n.lifecycle);
      if (!withLife.length) { notes.push(`${where}: the code declares no statuses for ${key}, so there is nothing to name.`); continue; }
      const scoped = withLife.filter((n) => f.root || under(n.lifecycle!.provenance[0]?.path, f.dir));
      if (!scoped.length) { notes.push(`${where}: ${key}'s statuses are declared outside ${f.dir}, so this file does not name them.`); continue; }
      for (const node of scoped) {
        const life = node.lifecycle!;
        const names: LifecycleNames = life.names ?? { views: {}, overlays: [], from: [] };
        let gave = false;
        const views = raw.views && typeof raw.views === 'object' ? raw.views : {};
        for (const [persona, words] of Object.entries(views)) {
          if (!words || typeof words !== 'object') { notes.push(`${where}.views.${persona} is not an object of words; it was not applied.`); continue; }
          for (const [word, statuses] of Object.entries(words)) {
            const w = str(word);
            const list = Array.isArray(statuses) ? statuses : typeof statuses === 'string' ? [statuses] : [];
            if (!w || !list.length) { notes.push(`${where}.views.${persona} gives ${JSON.stringify(word)} no status; it was not applied.`); continue; }
            for (const st of list) {
              if (typeof st !== 'string' || !life.statuses.includes(st)) {
                notes.push(`${where}.views.${persona}: ${JSON.stringify(st)} is not a status the code declares for ${node.name} (${life.statuses.join(', ')}); the word ${JSON.stringify(w)} was not given to it.`);
                continue;
              }
              const k = `${node.id}\u0000${persona}\u0000${st}`;
              const had = names.views[persona]?.[st];
              const first = setBy.get(k);
              if (had !== undefined && had !== w && first) {
                // a later file is nearer and its word stands; within one file the first word stays
                recordConflict(ws, 'lifecycle', `${node.name} · ${persona} · ${st}`, [first, f.path], first === f.path ? first : f.path);
                if (first === f.path) continue;
              }
              (names.views[persona] ??= {})[st] = w;
              setBy.set(k, f.path);
              gave = true;
            }
          }
        }
        for (const o of Array.isArray(raw.overlays) ? raw.overlays : raw.overlays === undefined ? [] : [null]) {
          const name = str(o?.name);
          const table = str(o?.table);
          const when = str(o?.when);
          if (!name || !table || !when) { notes.push(`${where}.overlays: an overlay needs a name, a table and when it holds; one was not applied.`); continue; }
          const repo = node.id.split('::')[0];
          const t = tables.find((n) => (n.id === table || n.name === table) && n.id.split('::')[0] === repo);
          if (!t) { notes.push(`${where}.overlays: ${JSON.stringify(name)} names the table ${JSON.stringify(table)}, which the code does not have; it was not applied.`); continue; }
          const at = names.overlays.findIndex((x) => x.name === name);
          const ov = { name, when, table, tableId: t.id };
          if (at >= 0) names.overlays[at] = ov; else names.overlays.push(ov);
          gave = true;
        }
        if (!gave) continue;
        if (!names.from.includes(f.path)) names.from.push(f.path);
        life.names = names;
        named.add(node);
      }
    }
  }
  return named.size;
}
