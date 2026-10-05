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

/** One config file's `journeys` block and the folder it applies to (`'.'` = the source root, every manifest). */
export interface JourneysBlock { from: string; dir: string; journeys: JourneysConfig }

/** A manifest a block reaches: the root's reaches every one; a nested file's, the manifests under its folder (never a URL). */
function blockReaches(b: JourneysBlock, manifestPath: string): boolean {
  if (!b.dir || b.dir === '.') return true;
  if (/^https?:\/\//i.test(manifestPath)) return false;
  return manifestPath.replace(/^\.\//, '').startsWith(`${b.dir.replace(/\/$/, '')}/`);
}

/**
 * Fold one source's manifests and config blocks into `JourneysMeta`.
 *
 * `config` is either one block (the root file's, as `farsight.config.json`) or the list
 * `journeysConfigFor` gives — root first, then each nested file nearest last. The blocks'
 * arrays come first and are the order (a block's ids in the order it lists them, the root's
 * before a nested file's); an entry overrides an earlier one and the manifest entry with the
 * same id field by field (only the fields it gives), so the nearest file's word stands; ids no
 * block names follow in manifest order, the first manifest to declare an id keeping it.
 * Personas and groups are one list per source wherever a block declares them; a placement
 * (`flows[]`) only places flows a manifest the block reaches declares — any other id is a note,
 * never a journey.
 */
export function journeysMetaOf(
  manifests: { manifest: DesignManifest; path: string }[],
  config?: JourneysConfig | JourneysBlock[] | null,
  configPath = 'farsight.config.json',
): JourneysMeta {
  const blocks: JourneysBlock[] = !config ? [] : Array.isArray(config) ? config : [{ from: configPath, dir: '.', journeys: config }];
  const notes: string[] = [];
  const personas: JourneysMeta['personas'] = [];
  const groups: JourneysMeta['groups'] = [];
  const pAt = new Map<string, number>();
  const gAt = new Map<string, number>();
  // the fields some block gave, per id — a manifest fills only the rest
  const cfgPersona = new Map<string, Set<string>>();
  const cfgGroup = new Map<string, Set<string>>();

  for (const b of blocks) {
    for (const p of b.journeys.personas ?? []) {
      const k = key(p.id);
      const given = cfgPersona.get(k) ?? new Set<string>();
      cfgPersona.set(k, given);
      let at = pAt.get(k);
      if (at == null) { at = personas.length; pAt.set(k, at); personas.push({ id: p.id, name: p.id, declared: true, from: b.from }); }
      const e = personas[at]!;
      if (p.name) { e.name = p.name; given.add('name'); }
      if (p.description) { e.description = p.description; given.add('description'); }
      if (p.name || p.description || !given.size) e.from = b.from;
    }
    for (const g of b.journeys.groups ?? []) {
      const k = key(g.id);
      const given = cfgGroup.get(k) ?? new Set<string>();
      cfgGroup.set(k, given);
      let at = gAt.get(k);
      if (at == null) { at = groups.length; gAt.set(k, at); groups.push({ id: g.id, name: g.id, declared: true, from: b.from }); }
      const e = groups[at]!;
      if (g.name) { e.name = g.name; given.add('name'); }
      if (g.description) { e.description = g.description; given.add('description'); }
      if (g.persona) { e.persona = g.persona; given.add('persona'); }
      if (g.name || g.description || g.persona || !given.size) e.from = b.from;
    }
  }
  // which manifest first declared each id, for the fields no block gave and for the notes
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
      const given = cfgPersona.get(k);
      if (given && !firstPersona.has(k)) {
        // a block named it: fill only what no block gave
        firstPersona.set(k, path);
        const e = personas[at]!;
        if (!given.has('name')) e.name = name;
        if (!given.has('description') && description) e.description = description;
      } else if (firstPersona.get(k) !== path && key(personas[at]!.name) !== key(name) && !given?.has('name')) {
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
      const given = cfgGroup.get(k);
      if (given && !firstGroup.has(k)) {
        firstGroup.set(k, path);
        const e = groups[at]!;
        if (!given.has('name')) e.name = name;
        if (!given.has('description') && description) e.description = description;
        if (!given.has('persona') && persona) e.persona = persona;
      } else if (firstGroup.get(k) !== path && key(groups[at]!.name) !== key(name) && !given?.has('name')) {
        notes.push(`group "${id}" is declared by ${firstGroup.get(k)} and ${path} with different names; "${groups[at]!.name}" from ${firstGroup.get(k)} is kept`);
      }
    }
  }

  // placements: only flows a manifest the block reaches declares; a nearer block overrides field by field
  const flows: JourneysMeta['flows'] = {};
  let index = 0;
  for (const b of blocks) {
    const flowIds = new Map<string, string>();
    for (const { manifest, path } of manifests) {
      if (!blockReaches(b, path)) continue;
      for (const f of Array.isArray(manifest.flows) ? manifest.flows : []) {
        const id = str(f?.id);
        if (id && !flowIds.has(key(id))) flowIds.set(key(id), id);
      }
    }
    const seen = new Set<string>();
    for (const f of b.journeys.flows ?? []) {
      const at = index++;
      const id = flowIds.get(key(f.id));
      if (!id) {
        notes.push(`flow "${f.id}" is named by ${b.from} but no manifest ${b.dir && b.dir !== '.' ? `under ${b.dir}/ ` : ''}declares it`);
        continue;
      }
      if (seen.has(id)) continue; // the same id twice in one block: the first
      seen.add(id);
      const prior = flows[id];
      flows[id] = {
        ...(prior ?? {}),
        ...(f.persona !== undefined ? { persona: f.persona } : {}),
        ...(f.group !== undefined ? { group: f.group } : {}),
        ...(f.order !== undefined ? { order: f.order } : {}),
        from: b.from,
        index: prior?.index ?? at,
      };
    }
  }
  const storylines = storylinesOf(manifests, blocks, notes);
  return { personas, groups, flows, ...(storylines.length ? { storylines } : {}), notes };
}

/** Every flow id these manifests declare, by its matching key. */
function flowIdsOf(manifests: { manifest: DesignManifest; path: string }[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const { manifest } of manifests) {
    for (const f of Array.isArray(manifest.flows) ? manifest.flows : []) {
      const id = str(f?.id);
      if (id && !ids.has(key(id))) ids.set(key(id), id);
    }
  }
  return ids;
}

/**
 * The storylines of one source (round-2026-10-05 §2.1): the blocks' entries first and in their order, then the
 * manifests' in manifest order; a block entry overrides an earlier one and the manifest entry with the same id,
 * field by field (a `journeys` list it gives replaces the whole list). The steps are flow ids a manifest
 * declares — a manifest's storyline may chain flows of every manifest of the source, a block's the flows of the
 * manifests it reaches; any other id, or an id named twice, is a note and never a step.
 */
function storylinesOf(
  manifests: { manifest: DesignManifest; path: string }[],
  blocks: JourneysBlock[],
  notes: string[],
): NonNullable<JourneysMeta['storylines']> {
  const out: NonNullable<JourneysMeta['storylines']> = [];
  const at = new Map<string, number>();
  const given = new Map<string, Set<string>>();
  /** the block whose `journeys` list stands, per storyline (absent: a manifest's) */
  const listFrom = new Map<string, JourneysBlock>();
  for (const b of blocks) {
    for (const s of b.journeys.storylines ?? []) {
      const k = key(s.id);
      const g = given.get(k) ?? new Set<string>();
      given.set(k, g);
      let i = at.get(k);
      if (i == null) { i = out.length; at.set(k, i); out.push({ id: s.id, name: s.id, journeys: [], declared: true, from: b.from }); }
      const e = out[i]!;
      if (s.name) { e.name = s.name; g.add('name'); }
      if (s.description) { e.description = s.description; g.add('description'); }
      if (s.journeys) { e.journeys = s.journeys.slice(); g.add('journeys'); listFrom.set(k, b); }
      if (s.name || s.description || s.journeys || !g.size) e.from = b.from;
    }
  }
  const first = new Map<string, string>();
  for (const { manifest, path } of manifests) {
    for (const raw of Array.isArray(manifest.storylines) ? manifest.storylines : []) {
      const id = str(raw?.id);
      if (!id) continue;
      const name = str(raw.name) ?? id;
      const description = str(raw.description);
      const journeys = (Array.isArray(raw.journeys) ? raw.journeys : []).map(str).filter((x): x is string => !!x);
      const k = key(id);
      const i = at.get(k);
      if (i == null) {
        at.set(k, out.length);
        first.set(k, path);
        out.push({ id, name, ...(description ? { description } : {}), journeys, declared: true, from: path });
        continue;
      }
      const g = given.get(k);
      if (g && !first.has(k)) {
        first.set(k, path);
        const e = out[i]!;
        if (!g.has('name')) e.name = name;
        if (!g.has('description') && description) e.description = description;
        if (!g.has('journeys')) e.journeys = journeys;
      } else if (first.get(k) !== path && !g?.has('journeys')) {
        notes.push(`storyline "${id}" is declared by ${first.get(k)} and ${path}; the one in ${first.get(k)} is kept`);
      }
    }
  }
  // the steps: only flows a manifest in reach declares, each once, in the order written
  const all = flowIdsOf(manifests);
  for (const s of out) {
    const b = listFrom.get(key(s.id));
    const ids = b ? flowIdsOf(manifests.filter((m) => blockReaches(b, m.path))) : all;
    const where = b && b.dir && b.dir !== '.' ? `under ${b.dir}/ ` : '';
    const steps: string[] = [];
    const own: string[] = [];
    for (const raw of s.journeys) {
      const id = ids.get(key(raw));
      if (!id) { own.push(`storyline "${s.id}" names journey "${raw}", which no manifest ${where}declares — it is not a step`); continue; }
      if (steps.includes(id)) { own.push(`storyline "${s.id}" names journey "${id}" twice — the first is its step`); continue; }
      steps.push(id);
    }
    s.journeys = steps;
    if (own.length) { s.notes = own; notes.push(...own); }
  }
  return out;
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
  /** every storyline (by id) this journey is a step of, in the tree's storyline order */
  storylines: string[];
}

/** One step of a storyline: the journey's row (its first place in the tree) and where it stands in the chain. */
export interface StorylineStep extends JourneyRow {
  /** its place in the storyline, 0-based — the surfaces print *step n of m* with n = stepIndex + 1 */
  stepIndex: number;
}

/** A storyline — a named chain of journeys across features and personas, in its declared order. */
export interface JourneyStoryline {
  id: string;
  name: string;
  description?: string;
  /** the source that declared it (a storyline chains the journeys of one source) */
  repo: string;
  /** the manifest or config path whose words it carries */
  from: string;
  journeys: StorylineStep[];
  counts: { journeys: Counted; built: Counted };
  /** what was set aside for this storyline: a named journey no manifest declares, one named twice, one out of scope */
  notes: string[];
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
  /** the storylines in declared order, each its journeys in step order — drawn above the personas */
  storylines: JourneyStoryline[];
  personas: JourneyPersona[];
  /** journeys counts each flow ONCE, however many personas show it */
  counts: { journeys: Counted; personas: Counted; groups: Counted; storylines: Counted };
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

function storylineCounts(steps: JourneyRow[], id: string): { journeys: Counted; built: Counted } {
  const built = steps.filter((r) => r.status === 'both').length;
  return {
    journeys: counted(steps.length, 'count.unit.journeys', 'count.scope.storyline', `${SRC} → storylines[${id}].journeys`, { bizUnit: 'count.unit.journeys' }),
    built: counted(built, 'count.unit.journeysBuilt', 'count.scope.storyline', `${SRC} → storylines[${id}].journeys where status = both`, { of: steps.length, bizUnit: 'count.unit.journeysBuilt' }),
  };
}

function treeCounts(personas: JourneyPersona[], storylines: JourneyStoryline[]): JourneyTree['counts'] {
  const unique = new Set(personas.flatMap((p) => p.groups.flatMap((g) => g.journeys.map((j) => j.nodeId))));
  const sections = personas.reduce((n, p) => n + p.groups.length, 0);
  return {
    storylines: counted(storylines.length, 'count.unit.storylines', 'count.scope.workspace', `${SRC} → storylines`, { bizUnit: 'count.unit.storylines' }),
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
          storylines: [],
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
  const storylines = storylinesFold(personas, inScope, notes);
  return { storylines, personas, counts: treeCounts(personas, storylines), derived: derivedAny, notes };
}

/**
 * The storylines of the sources in scope, in source then declared order, each its journeys as steps — the
 * journey's first row in the tree with its `stepIndex`. One storyline per id: a second source declaring the
 * same id is a note (storylines chain the journeys of one source). Every row of the tree learns which
 * storylines it is a step of. O(journeys + steps).
 */
function storylinesFold(personas: JourneyPersona[], inScope: [string, JourneysMeta][], notes: string[]): JourneyStoryline[] {
  const firstRow = new Map<string, JourneyRow>();
  const rowsOf = new Map<string, JourneyRow[]>();
  for (const p of personas) for (const g of p.groups) for (const j of g.journeys) {
    if (!firstRow.has(j.nodeId)) firstRow.set(j.nodeId, j);
    const list = rowsOf.get(j.nodeId) ?? [];
    list.push(j);
    rowsOf.set(j.nodeId, list);
  }
  const declared: { repo: string; s: NonNullable<JourneysMeta['storylines']>[number]; nodeIds: string[]; own: string[] }[] = [];
  const seen = new Map<string, string>();
  for (const [repo, m] of inScope) {
    for (const s of m.storylines ?? []) {
      const k = key(s.id);
      if (seen.has(k)) { notes.push(`storyline "${s.id}" is declared by ${seen.get(k)} and ${repo}; the one in ${seen.get(k)} is kept`); continue; }
      seen.set(k, repo);
      const own = [...(s.notes ?? [])];
      const nodeIds: string[] = [];
      for (const fid of s.journeys ?? []) {
        const nodeId = `${repo}::flow::${fid}`;
        if (!firstRow.has(nodeId)) { own.push(`journey "${fid}" is not drawn in this scope — it is not a step here`); continue; }
        if (!nodeIds.includes(nodeId)) nodeIds.push(nodeId);
      }
      declared.push({ repo, s, nodeIds, own });
    }
  }
  // every row of a journey shares one list of the storylines it is a step of
  const memberOf = new Map<string, string[]>();
  for (const d of declared) for (const nodeId of d.nodeIds) {
    const list = memberOf.get(nodeId) ?? [];
    if (!list.includes(d.s.id)) list.push(d.s.id);
    memberOf.set(nodeId, list);
  }
  for (const [nodeId, list] of memberOf) for (const r of rowsOf.get(nodeId) ?? []) r.storylines = list;
  return declared.map(({ repo, s, nodeIds, own }) => {
    const journeys: StorylineStep[] = nodeIds.map((nodeId, i) => ({ ...firstRow.get(nodeId)!, stepIndex: i }));
    return {
      id: s.id, name: s.name,
      ...(s.description ? { description: s.description } : {}),
      repo, from: s.from,
      journeys,
      counts: storylineCounts(journeys, s.id),
      notes: own,
    };
  });
}

// ── reading the tree ─────────────────────────────────────────────────────

const matches = (x: { id: string; name: string }, q: string) => key(x.id) === key(q) || key(x.name) === key(q);

/**
 * The tree narrowed to one persona, one group and/or one storyline (each by id or name); the tree's own counts
 * follow what is kept. A storyline keeps that storyline only, and under the personas only its journeys.
 */
export function pickJourneys(tree: JourneyTree, opts: { persona?: string; group?: string; storyline?: string } = {}): JourneyTree {
  const storylines = (tree.storylines ?? []).filter((s) => !opts.storyline || matches(s, opts.storyline));
  const inStory = opts.storyline ? new Set(storylines.flatMap((s) => s.journeys.map((j) => j.nodeId))) : null;
  const personas = tree.personas
    .filter((p) => !opts.persona || matches(p, opts.persona))
    .map((p) => {
      if (!opts.group && !inStory) return p;
      const groups = p.groups
        .filter((g) => !opts.group || matches(g, opts.group))
        .map((g) => (inStory ? { ...g, journeys: g.journeys.filter((j) => inStory.has(j.nodeId)), counts: groupCounts(g.journeys.filter((j) => inStory.has(j.nodeId)), 'count.scope.group', `${p.id}/${g.id}`) } : g))
        .filter((g) => g.journeys.length);
      return { ...p, groups, counts: groupCounts(groups.flatMap((g) => g.journeys), 'count.scope.persona', p.id) };
    })
    .filter((p) => p.groups.length);
  return { ...tree, storylines, personas, counts: treeCounts(personas, storylines), derived: personas.some((p) => p.derived) };
}

/** Where a journey stands in each storyline it is a step of: `{ storyline, step, of, prev?, next? }` (step 1-based). */
export function storylinePlacements(tree: JourneyTree, nodeId: string): { id: string; name: string; step: number; of: number; prev?: string; next?: string }[] {
  const out: { id: string; name: string; step: number; of: number; prev?: string; next?: string }[] = [];
  for (const s of tree.storylines ?? []) {
    const i = s.journeys.findIndex((j) => j.nodeId === nodeId);
    if (i < 0) continue;
    out.push({
      id: s.id, name: s.name, step: i + 1, of: s.journeys.length,
      ...(i > 0 ? { prev: s.journeys[i - 1]!.nodeId } : {}),
      ...(i < s.journeys.length - 1 ? { next: s.journeys[i + 1]!.nodeId } : {}),
    });
  }
  return out;
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
  const stories = c.storylines && c.storylines.n ? `${countedText(c.storylines, { scope: false })} · ` : '';
  const head = `${countedText(c.journeys, { scope: false })} · ${stories}${countedText(c.personas, { scope: false })} · ${countedText(c.groups)}`;
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
  if (tree.storylines?.length) {
    // the storylines first: the whole life of one business thing, across the personas below
    lines.push('', `## ${t('journeys.storyline.title', 'professional')} — ${countedText(tree.counts.storylines, { scope: false })}`);
    for (const s of tree.storylines) {
      lines.push(`### ${s.name} (\`${s.id}\`) — ${countedText(s.counts.journeys, { scope: false })} · ${countedText(s.counts.built, { scope: false })}${s.description ? ` — ${s.description}` : ''}`);
      for (const j of s.journeys) {
        const word = flowStatusWord(j.built, j.total);
        lines.push(`${j.stepIndex + 1}. ${j.name} — ${word.text} · \`${j.nodeId}\`${opts.openHint ? ` ${opts.openHint}` : ''}`);
      }
      for (const n of s.notes.filter((x) => !tree.notes.some((y) => y.endsWith(x)))) lines.push(`- note: ${n}`);
    }
  }
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
