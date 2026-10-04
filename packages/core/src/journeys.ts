/**
 * Journeys organised by persona and group, in the order the design declares
 * (docs/proposals/journey-organisation-and-config-files.md §4).
 *
 * Two pure folds:
 *
 * - `journeysMetaOf()` runs at ingest, once per source: every manifest's
 *   `personas[]` / `groups[]` and the config's `journeys` block become
 *   `meta.journeys[repo]` — the declarations in order, the config's placements
 *   by flow id, and a sentence for whatever was set aside.
 * - `journeyTree()` runs at request time over `designSurface()`'s flow rows and
 *   those metas: persona → group → journeys. `/api/journeys`, the MCP
 *   `journeys` tool and `farsight journeys` all call it, so the three cannot
 *   disagree about where a journey sits or how many there are.
 *
 * Matching is by id, then by name (case-insensitive, trimmed). A value nothing
 * declares becomes a heading of its own (`declared: false`) after the declared
 * ones, alphabetically — so a manifest written before personas existed reads
 * the way it always did. A flow naming no persona falls back to the shared
 * prefix of its screen ids (`derived`), and failing that to the trailing
 * *Not grouped* persona; a flow naming no group sits in the persona's trailing
 * *Other journeys* group.
 */
import type { JourneysMeta, JourneyGroupDecl, JourneyPersonaDecl } from './graph.js';
import type { JourneysConfig } from './config.js';
import { designSurface, flowStatusWord, type DesignManifest, type FlowRow } from './design.js';
import { counted, countedText, type Counted } from './counts.js';
import { t } from './strings.js';
import type { GraphIndex } from './query.js';

/** The id of the trailing persona for journeys that name nobody and whose screens share no prefix. */
export const JOURNEY_NO_PERSONA = '_none';
/** The id of a persona's trailing group for journeys that name no group (or a group that is another persona's). */
export const JOURNEY_NO_GROUP = '_other';

const key = (s: string): string => s.trim().toLowerCase();
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// ── ingest: the declarations of one source ───────────────────────────────

/**
 * Fold one source's manifests and config into `JourneysMeta`. The config's
 * arrays come first and are the order; a config entry overrides the manifest
 * entry with the same id field by field (only the fields it gives); ids the
 * config does not name follow in manifest order, the first manifest to declare
 * an id keeping it. A config placement for a flow no manifest declares is a
 * note, never a journey.
 */
export function journeysMetaOf(
  manifests: { manifest: DesignManifest; path: string }[],
  config?: JourneysConfig | null,
  configPath = 'farsight.config.json',
): JourneysMeta {
  const notes: string[] = [];
  const personas: JourneysMeta['personas'] = [];
  const groups: JourneysMeta['groups'] = [];
  const pAt = new Map<string, number>();
  const gAt = new Map<string, number>();

  for (const p of config?.personas ?? []) {
    if (pAt.has(key(p.id))) continue;
    pAt.set(key(p.id), personas.length);
    personas.push({ id: p.id, name: p.name ?? p.id, ...(p.description ? { description: p.description } : {}), declared: true, from: configPath });
  }
  for (const g of config?.groups ?? []) {
    if (gAt.has(key(g.id))) continue;
    gAt.set(key(g.id), groups.length);
    groups.push({ id: g.id, name: g.name ?? g.id, ...(g.description ? { description: g.description } : {}), ...(g.persona ? { persona: g.persona } : {}), declared: true, from: configPath });
  }
  const cfgPersona = new Map((config?.personas ?? []).map((p) => [key(p.id), p]));
  const cfgGroup = new Map((config?.groups ?? []).map((g) => [key(g.id), g]));
  // which manifest first declared each id, for the fields the config left out and for the notes
  const firstPersona = new Map<string, string>();
  const firstGroup = new Map<string, string>();

  for (const { manifest, path } of manifests) {
    for (const raw of Array.isArray(manifest.personas) ? manifest.personas : []) {
      const id = str((raw as Partial<JourneyPersonaDecl>)?.id);
      if (!id) continue;
      const name = str(raw.name) ?? id;
      const description = str(raw.description);
      const k = key(id);
      const at = pAt.get(k);
      if (at == null) {
        pAt.set(k, personas.length);
        firstPersona.set(k, path);
        personas.push({ id, name, ...(description ? { description } : {}), declared: true, from: path });
        continue;
      }
      const cfg = cfgPersona.get(k);
      if (cfg && !firstPersona.has(k)) {
        // the config named it: fill only what the config left out
        firstPersona.set(k, path);
        const e = personas[at]!;
        if (!cfg.name) e.name = name;
        if (!cfg.description && description) e.description = description;
      } else if (firstPersona.get(k) !== path && key(personas[at]!.name) !== key(name) && !cfg?.name) {
        notes.push(`persona "${id}" is declared by ${firstPersona.get(k)} and ${path} with different names; "${personas[at]!.name}" from ${firstPersona.get(k)} is kept`);
      }
    }
    for (const raw of Array.isArray(manifest.groups) ? manifest.groups : []) {
      const id = str((raw as Partial<JourneyGroupDecl>)?.id);
      if (!id) continue;
      const name = str(raw.name) ?? id;
      const description = str(raw.description);
      const persona = str(raw.persona);
      const k = key(id);
      const at = gAt.get(k);
      if (at == null) {
        gAt.set(k, groups.length);
        firstGroup.set(k, path);
        groups.push({ id, name, ...(description ? { description } : {}), ...(persona ? { persona } : {}), declared: true, from: path });
        continue;
      }
      const cfg = cfgGroup.get(k);
      if (cfg && !firstGroup.has(k)) {
        firstGroup.set(k, path);
        const e = groups[at]!;
        if (!cfg.name) e.name = name;
        if (!cfg.description && description) e.description = description;
        if (!cfg.persona && persona) e.persona = persona;
      } else if (firstGroup.get(k) !== path && key(groups[at]!.name) !== key(name) && !cfg?.name) {
        notes.push(`group "${id}" is declared by ${firstGroup.get(k)} and ${path} with different names; "${groups[at]!.name}" from ${firstGroup.get(k)} is kept`);
      }
    }
  }

  // placements: only flows some manifest of this source declares
  const flowIds = new Map<string, string>();
  for (const { manifest } of manifests) {
    for (const f of Array.isArray(manifest.flows) ? manifest.flows : []) {
      const id = str(f?.id);
      if (id && !flowIds.has(key(id))) flowIds.set(key(id), id);
    }
  }
  const flows: JourneysMeta['flows'] = {};
  (config?.flows ?? []).forEach((f, index) => {
    const id = flowIds.get(key(f.id));
    if (!id) { notes.push(`flow "${f.id}" is named by ${configPath} but no manifest declares it`); return; }
    if (flows[id]) return;
    flows[id] = {
      ...(f.persona !== undefined ? { persona: f.persona } : {}),
      ...(f.group !== undefined ? { group: f.group } : {}),
      ...(f.order !== undefined ? { order: f.order } : {}),
      from: configPath, index,
    };
  });
  return { personas, groups, flows, notes };
}

// ── request time: the tree ───────────────────────────────────────────────

/** One journey where the tree shows it: the design's flow row with the organisation applied. */
export interface JourneyRow extends FlowRow {
  /** the design source (manifest) it was declared in */
  designId: string;
  /** every persona id of this tree the journey is shown under (one row per persona) */
  personaIds: string[];
  /** the same personas' names, in the same order */
  personaNames: string[];
  /** the group section it sits in under this persona */
  groupId: string;
  /** the persona's way in: the first journey nothing requires with something built and the most screens (else the first one nothing requires) */
  pinned: boolean;
  /** the catalog key of its one status word (flowStatusWord) */
  statusKey: string;
  /** the config file whose `journeys.flows` entry moved it; absent when the manifest placed it */
  placedBy?: string;
}

export interface JourneyGroup {
  id: string;
  name: string;
  description?: string;
  declared: boolean;
  /** the catalog key the name was printed from, for the trailing *Other journeys* group — a register-aware surface prints its own words */
  key?: string;
  journeys: JourneyRow[];
  counts: { journeys: Counted; built: Counted };
}

export interface JourneyPersona {
  id: string;
  name: string;
  description?: string;
  declared: boolean;
  /** some journey sits here because its screen ids share this prefix, not because the design named it */
  derived?: boolean;
  /** the catalog key the name was printed from, for the trailing *Not grouped* persona */
  key?: string;
  groups: JourneyGroup[];
  counts: { journeys: Counted; built: Counted };
}

export interface JourneyTree {
  personas: JourneyPersona[];
  /** journeys counts each flow ONCE, however many personas show it */
  counts: { journeys: Counted; personas: Counted; groups: Counted };
  /** some persona came from a screen-id prefix */
  derived: boolean;
  notes: string[];
}

const SRC = 'journeyTree';

function groupCounts(rows: JourneyRow[], scope: 'count.scope.persona' | 'count.scope.group', where: string): { journeys: Counted; built: Counted } {
  const built = rows.filter((r) => r.status === 'both').length;
  return {
    journeys: counted(rows.length, 'count.unit.journeys', scope, `${SRC} → ${where}.journeys`, { bizUnit: 'count.unit.journeys' }),
    built: counted(built, 'count.unit.journeysBuilt', scope, `${SRC} → ${where}.journeys where status = both`, { of: rows.length, bizUnit: 'count.unit.journeysBuilt' }),
  };
}

function treeCounts(personas: JourneyPersona[]): JourneyTree['counts'] {
  const unique = new Set(personas.flatMap((p) => p.groups.flatMap((g) => g.journeys.map((j) => j.nodeId))));
  const sections = personas.reduce((n, p) => n + p.groups.length, 0);
  return {
    journeys: counted(unique.size, 'count.unit.journeys', 'count.scope.workspace', `${SRC} → distinct flow node ids`, { bizUnit: 'count.unit.journeys' }),
    personas: counted(personas.length, 'count.unit.personas', 'count.scope.workspace', `${SRC} → personas`, { bizUnit: 'count.unit.personas' }),
    groups: counted(sections, 'count.unit.groups', 'count.scope.workspace', `${SRC} → personas[].groups (one per persona it is shown under)`, { bizUnit: 'count.unit.groups' }),
  };
}

interface Placed { row: FlowRow; designId: string; seq: number; persona?: string | string[]; group?: string; order?: number; cfgIndex?: number; placedBy?: string }

/**
 * Persona → group → journeys over the flows in scope. `metas` is
 * `GraphMeta.journeys` (absent on a graph ingested before this pass: every
 * persona and group is then undeclared, in the order and words the manifest
 * gives). `scope` is the set of sources to keep, `null`/absent for all.
 */
export function journeyTree(index: GraphIndex, metas: Record<string, JourneysMeta> | undefined, scope?: Set<string> | null): JourneyTree {
  const inScope = Object.entries(metas ?? {}).filter(([repo]) => !scope || scope.has(repo)).sort((a, b) => a[0].localeCompare(b[0]));

  // the declarations, across the sources in scope: one persona per id, the first source's words
  const pDecl: JourneysMeta['personas'] = [];
  const gDecl: JourneysMeta['groups'] = [];
  const pById = new Map<string, JourneysMeta['personas'][number]>();
  const pByName = new Map<string, JourneysMeta['personas'][number]>();
  const gById = new Map<string, JourneysMeta['groups'][number]>();
  const gByName = new Map<string, JourneysMeta['groups'][number]>();
  for (const [, m] of inScope) {
    for (const p of m.personas ?? []) if (!pById.has(key(p.id))) { pById.set(key(p.id), p); pDecl.push(p); }
    for (const g of m.groups ?? []) if (!gById.has(key(g.id))) { gById.set(key(g.id), g); gDecl.push(g); }
  }
  for (const p of pDecl) if (!pByName.has(key(p.name))) pByName.set(key(p.name), p);
  for (const g of gDecl) if (!gByName.has(key(g.name))) gByName.set(key(g.name), g);
  const pIndex = new Map(pDecl.map((p, i) => [p.id, i]));
  const gIndex = new Map(gDecl.map((g, i) => [g.id, i]));

  // the flows, in manifest order: sources and manifests as designSurface orders them, then the
  // position each flow had in its manifest (a graph from before positions were kept: by name)
  const placed: Placed[] = [];
  const seen = new Set<string>();
  let seq = 0;
  for (const d of designSurface(index, scope ?? null)) {
    const flows = d.flows.map((f, i) => ({ f, i })).sort((a, b) => (a.f.position ?? Infinity) - (b.f.position ?? Infinity) || a.i - b.i).map((x) => x.f);
    for (const row of flows) {
      if (seen.has(row.nodeId)) continue; // one flow contained by two manifests (a repeated id): the first
      seen.add(row.nodeId);
      const ov = metas?.[row.repo]?.flows?.[row.id];
      placed.push({
        row, designId: d.id, seq: seq++,
        ...((ov?.persona ?? row.persona) !== undefined ? { persona: ov?.persona ?? row.persona } : {}),
        ...((ov?.group ?? row.group) !== undefined ? { group: ov?.group ?? row.group } : {}),
        ...((ov?.order ?? row.order) !== undefined ? { order: ov?.order ?? row.order } : {}),
        ...(ov ? { cfgIndex: ov.index, placedBy: ov.from } : {}),
      });
    }
  }

  // persona headings, keyed so a value written two ways is one heading
  interface PBucket { id: string; name: string; description?: string; declared: boolean; derived: boolean; none: boolean; groups: Map<string, GBucket> }
  interface GBucket { id: string; name: string; description?: string; declared: boolean; none: boolean; rows: Placed[] }
  const pBuckets = new Map<string, PBucket>();
  let derivedAny = false;

  const resolvePersona = (value: string): { k: string; id: string; name: string; description?: string; declared: boolean } => {
    const d = pById.get(key(value)) ?? pByName.get(key(value));
    if (d) return { k: `d:${key(d.id)}`, id: d.id, name: d.name, ...(d.description ? { description: d.description } : {}), declared: true };
    return { k: `u:${key(value)}`, id: value.trim(), name: value.trim(), declared: false };
  };

  for (const p of placed) {
    const values = typeof p.persona === 'string' ? [p.persona] : Array.isArray(p.persona) ? p.persona : [];
    const targets: { k: string; id: string; name: string; description?: string; declared: boolean; derived?: boolean; none?: boolean }[] = [];
    for (const v of values) if (str(v)) targets.push(resolvePersona(v));
    if (!targets.length) {
      // the fallback the front door always had: the one prefix every screen id shares
      const prefixes = [...new Set(p.row.screens.map((x) => String(x).split('-')[0]!).filter(Boolean))];
      if (prefixes.length === 1) targets.push({ k: `u:${key(prefixes[0]!)}`, id: prefixes[0]!, name: prefixes[0]!, declared: false, derived: true });
      else targets.push({ k: 'none', id: JOURNEY_NO_PERSONA, name: t('portfolio.noPersona', 'professional'), declared: false, none: true });
    }
    const unique = [...new Map(targets.map((x) => [x.k, x])).values()];
    for (const tg of unique) {
      let pb = pBuckets.get(tg.k);
      if (!pb) {
        pb = { id: tg.id, name: tg.name, ...(tg.description ? { description: tg.description } : {}), declared: tg.declared, derived: false, none: !!tg.none, groups: new Map() };
        pBuckets.set(tg.k, pb);
      }
      if (tg.derived) { pb.derived = true; derivedAny = true; }
      // the group: declared (and this persona's, when it names one), undeclared, or Other journeys
      let gk = 'none';
      let gb: Omit<GBucket, 'rows'> = { id: JOURNEY_NO_GROUP, name: t('journeys.noGroup', 'professional'), declared: false, none: true };
      const gv = str(p.group);
      if (gv) {
        const d = gById.get(key(gv)) ?? gByName.get(key(gv));
        if (d) {
          const owner = d.persona ? resolvePersona(d.persona).k : null;
          if (!owner || owner === tg.k) { gk = `d:${key(d.id)}`; gb = { id: d.id, name: d.name, ...(d.description ? { description: d.description } : {}), declared: true, none: false }; }
        } else {
          gk = `u:${key(gv)}`;
          gb = { id: gv, name: gv, declared: false, none: false };
        }
      }
      let g = pb.groups.get(gk);
      if (!g) { g = { ...gb, rows: [] }; pb.groups.set(gk, g); }
      g.rows.push(p);
    }
  }

  const alpha = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);
  const rank = <T extends { declared: boolean; none: boolean; id: string; name: string }>(list: T[], at: Map<string, number>): T[] => [
    ...list.filter((x) => x.declared).sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0)),
    ...list.filter((x) => !x.declared && !x.none).sort(alpha),
    ...list.filter((x) => x.none),
  ];
  const journeyOrder = (a: Placed, b: Placed) => {
    const ao = a.order != null ? 0 : 1;
    const bo = b.order != null ? 0 : 1;
    return ao - bo || (a.order ?? 0) - (b.order ?? 0) || (a.cfgIndex ?? Infinity) - (b.cfgIndex ?? Infinity) || a.seq - b.seq;
  };

  const personaIdsOf = new Map<string, { ids: string[]; names: string[] }>();
  const personas: JourneyPersona[] = rank([...pBuckets.values()], pIndex).map((pb) => {
    const groups = rank([...pb.groups.values()], gIndex).map((gb) => {
      const journeys: JourneyRow[] = gb.rows.slice().sort(journeyOrder).map((p) => {
        const r: JourneyRow = {
          ...p.row,
          designId: p.designId,
          personaIds: [],
          personaNames: [],
          groupId: gb.id,
          pinned: false,
          statusKey: flowStatusWord(p.row.built, p.row.total).key,
          ...(p.placedBy ? { placedBy: p.placedBy } : {}),
        };
        // the organisation applied: what the tree placed it by, not only what the manifest said
        if (p.persona !== undefined) r.persona = p.persona; else delete r.persona;
        if (p.group !== undefined) r.group = p.group; else delete r.group;
        if (p.order !== undefined) r.order = p.order; else delete r.order;
        const under = personaIdsOf.get(r.nodeId) ?? { ids: [], names: [] };
        if (!under.ids.includes(pb.id)) { under.ids.push(pb.id); under.names.push(pb.name); }
        personaIdsOf.set(r.nodeId, under);
        // shared: every row of one flow lists every persona it is under
        r.personaIds = under.ids;
        r.personaNames = under.names;
        return r;
      });
      return {
        id: gb.id, name: gb.name,
        ...(gb.description ? { description: gb.description } : {}),
        declared: gb.declared,
        ...(gb.none ? { key: 'journeys.noGroup' } : {}),
        journeys,
        counts: groupCounts(journeys, 'count.scope.group', `${pb.id}/${gb.id}`),
      };
    });
    // the way in, per persona: the rule the front door has always used, in this persona's order
    const all = groups.flatMap((g) => g.journeys);
    const entries = all.filter((j) => !j.requires.length);
    const pin = entries.filter((j) => j.built > 0).reduce<JourneyRow | undefined>((best, j) => (!best || j.total > best.total ? j : best), undefined) ?? entries[0] ?? all[0];
    if (pin) pin.pinned = true;
    return {
      id: pb.id, name: pb.name,
      ...(pb.description ? { description: pb.description } : {}),
      declared: pb.declared,
      ...(pb.derived ? { derived: true } : {}),
      ...(pb.none ? { key: 'portfolio.noPersona' } : {}),
      groups,
      counts: groupCounts(all, 'count.scope.persona', pb.id),
    };
  });

  const multi = inScope.length > 1;
  const notes = inScope.flatMap(([repo, m]) => (m.notes ?? []).map((n) => (multi ? `${repo}: ${n}` : n)));
  return { personas, counts: treeCounts(personas), derived: derivedAny, notes };
}

// ── reading the tree ─────────────────────────────────────────────────────

const matches = (x: { id: string; name: string }, q: string) => key(x.id) === key(q) || key(x.name) === key(q);

/** The tree narrowed to one persona and/or one group (by id or name); the tree's own counts follow what is kept. */
export function pickJourneys(tree: JourneyTree, opts: { persona?: string; group?: string } = {}): JourneyTree {
  const personas = tree.personas
    .filter((p) => !opts.persona || matches(p, opts.persona))
    .map((p) => {
      if (!opts.group) return p;
      const groups = p.groups.filter((g) => matches(g, opts.group!));
      return { ...p, groups, counts: groupCounts(groups.flatMap((g) => g.journeys), 'count.scope.persona', p.id) };
    })
    .filter((p) => p.groups.length);
  return { ...tree, personas, counts: treeCounts(personas), derived: personas.some((p) => p.derived) };
}

/** Where a journey sits: one persona › group pair per persona it is shown under. */
export function journeyPlacements(tree: JourneyTree, nodeId: string): { persona: string; group: string; pinned: boolean }[] {
  const out: { persona: string; group: string; pinned: boolean }[] = [];
  for (const p of tree.personas) for (const g of p.groups) for (const j of g.journeys) if (j.nodeId === nodeId) out.push({ persona: p.name, group: g.name, pinned: j.pinned });
  return out;
}

/** `18 journeys · 2 personas · 6 groups across every source in scope`, then the first group of each persona. */
export function journeyTreeSummary(tree: JourneyTree): string {
  const c = tree.counts;
  const head = `${countedText(c.journeys, { scope: false })} · ${countedText(c.personas, { scope: false })} · ${countedText(c.groups)}`;
  const firsts = tree.personas.map((p) => `${p.name} › ${p.groups[0]?.name ?? ''}`);
  return firsts.length ? `${head} — first: ${firsts.join(' · ')}` : head;
}

/**
 * The tree as text — what the MCP `journeys` tool and `farsight journeys`
 * print: a persona heading, a group heading, one line per journey with its
 * status word, how much of it is built and its node id, then the notes.
 */
export function journeyTreeLines(tree: JourneyTree, opts: { openHint?: string } = {}): string[] {
  const lines: string[] = [];
  if (!tree.personas.length) return ['no journeys in scope — a design manifest (docs/design/screens.json) declares them as flows; design_guide explains how'];
  lines.push(journeyTreeSummary(tree).replace(/ — first: .*$/, ''));
  if (tree.derived) lines.push(`(${t('portfolio.personaDerived', 'professional')})`);
  for (const p of tree.personas) {
    lines.push('', `## ${p.name}${p.declared ? '' : p.key ? '' : p.derived ? ' (derived from screen ids)' : ' (not declared in personas[])'} — ${countedText(p.counts.journeys, { scope: false })} · ${countedText(p.counts.built, { scope: false })}${p.description ? ` — ${p.description}` : ''}`);
    for (const g of p.groups) {
      lines.push(`### ${g.name}${g.declared || g.key ? '' : ' (not declared in groups[])'} — ${countedText(g.counts.journeys, { scope: false })}${g.description ? ` — ${g.description}` : ''}`);
      for (const j of g.journeys) {
        const word = flowStatusWord(j.built, j.total);
        // a status word that already says n of m is not followed by the same numbers again
        const built = t(word.key, 'professional').includes('{m}') ? '' : ` · built ${j.built} of ${j.total}`;
        const others = j.personaIds.length > 1 ? ` · also under ${j.personaNames.filter((_, i) => j.personaIds[i] !== p.id).join(', ')}` : '';
        lines.push(`- ${j.name} — ${word.text}${built}${j.pinned ? ` · ${t('portfolio.pinned', 'professional')}` : ''}${others}${j.placedBy ? ` · placed by ${j.placedBy}` : ''} · \`${j.nodeId}\`${opts.openHint ? ` ${opts.openHint}` : ''}`);
      }
    }
  }
  if (tree.notes.length) lines.push('', '## notes', ...tree.notes.map((n) => `- ${n}`));
  return lines;
}
