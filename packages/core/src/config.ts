import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { configSchemaProblem } from '@farsight/graph/config';
import type {
  GraphNode,
  GraphEdge,
  StoreKind,
  StoreEngine,
  TagDimension,
  JourneyStorylineEntryDecl,
  JourneyStorylineLaneDecl,
  JourneyStorylineHandoffDecl,
  DecisionDecl,
  FrameworksConfig,
  FrameworkAliasSummary,
} from './graph.js';
export type { FrameworksConfig } from './graph.js';
import { humanizeName } from './query.js';
import { t } from './strings.js';
import { normalizeRoutePath } from './openapi.js';

/** A fact supplied by a person, without source matching or executable code. */
export interface NodeDecl {
  kind: 'route' | 'guard' | 'external' | 'queue';
  name: string;
  /** A file relative to this config's folder, followed by its line. */
  loc?: string;
  /** An existing node id or a folder-relative path::name. */
  handler?: string;
  guards?: string[];
  tier?: 'business' | 'policy' | 'technical';
  /** Guard grant, carried on its guards edges; a label alone supplies no grant. */
  requires?: string;
  business?: string;
}

/** Declarative source matching. Templates refer to captures with $name; no executable adapters. */
export interface PatternDecl {
  id: string;
  files: string[];
  match:
    | { call: string; args?: Record<string, number | `pair:${string}`> }
    | { decorator: string; args?: Record<string, number | `pair:${string}`> }
    | { annotation: string; args?: Record<string, number | `pair:${string}`> }
    | { query: string }
    | { regex: string };
  emit: {
    kind: 'route' | 'guard' | 'external' | 'queue' | 'rule' | 'flag' | 'entrypoint';
    name?: string;
    method?: string;
    path?: string;
    topic?: string;
    handler?: string;
    guards?: string;
    /** Grant captured at the matched guard site; carried on its guards edge. */
    requires?: string;
    publishes?: string;
    consumes?: string;
    validates?: string;
    tier?: 'business' | 'policy' | 'technical';
    tags?: string[];
    business?: string;
  };
  business?: string;
}

/**
 * Workspace config (farsight.config.json at the ingest root).
 * Phase 1 supports tag rules, a business glossary, and declared guards /
 * entry points; repos/lens/role presets land in Phase 2 (see docs/ROADMAP.md).
 */
export interface FarsightConfig {
  /** tag → list of matchers. A node matches on substring of its path or name (case-insensitive). */
  tags?: Record<string, string[]>;
  /**
   * node name (or `METHOD /path` for routes) → business-lens label/description. A class
   * member (`PgBcOutboxRepository.claimNext`) matches, in order: its exact name, then its
   * member part (`claimNext`), then its class part (`PgBcOutboxRepository` — labelled as the
   * class's words plus the member, humanized). See `glossaryEntryFor`.
   */
  glossary?: Record<string, { label: string; description?: string }>;
  /**
   * guard label → matchers. A function matcher (substring of path or name) turns the
   * function into a guard node (🔒) and flips calls into it to guards edges on the caller —
   * for auth wrappers no adapter understands yet (withTenant…). A route matcher
   * (`GET /api/v1/track/{token}`) declares a gate on that route — for capability URLs
   * OpenAPI cannot express — as a `declared` guard node; api drift reports
   * `security-declared-only` when the built handler enforces nothing the parser can see.
   */
  guards?: Record<string, string[]>;
  /**
   * matcher → tier: the tier a gate is in when its class gives the wrong one (gates lane 2026-10-10).
   * A matcher is an exact node id or a substring of `path name`, the guards' shape; it applies to
   * guards and rules (preconditions included). A `@guard[tier]` the code carries wins over it.
   */
  gateTiers?: Record<string, 'business' | 'policy' | 'technical'>;
  /** entrypoint label → matchers. Matching nodes get searchable entrypoint tags so trace_flow can seed from them (cron/queue jobs…). */
  entrypoints?: Record<string, string[]>;
  /** OpenAPI/Swagger documents describing this repo's HTTP surface — a repo-relative path or a URL each. Discovery by filename still runs; this adds specs it would not find (e.g. served by the API itself). */
  openapi?: { path?: string; url?: string; name?: string; phase?: string; phaseOrder?: string[] }[];
  /** Exact internal METHOD /path declarations, excluded from undocumented-policy failures only. */
  internalRoutes?: string[];
  /** Multipart readers: exact function names or ids; reconciliation requires a real call path. */
  validators?: string[];
  /** Design manifests (docs/design/screens.json) describing this repo's screens — see docs/proposals/design-source.md. Discovery by filename still runs. */
  design?: { manifest?: string; path?: string; url?: string; name?: string }[];
  /** Test suites and the reports that observed them — see docs/proposals/tests-surface.md §3.2. Discovery by glob still runs; this adds report locations and extra spec globs. */
  tests?: TestsConfigBlock;
  /** third-party systems the parser cannot see by itself, or renames/kinds for ones it can */
  externals?: ExternalDecl[];
  /** Names that the built-in Spring, Nest and Express readers interpret using their existing semantics. */
  frameworks?: FrameworksConfig;
  /** Each nested file's rules select only files under its own folder. */
  patterns?: PatternDecl[];
  /** Hand-made declarations, scoped to the config file's folder. */
  nodes?: NodeDecl[];
  /** the data stores the repo's tables live in, when the code does not say — fills the gap, never overrides code (`via: 'config'`) */
  stores?: StoreDecl[];
  /** glob(s) whose functions are plumbing regardless of @business: helpers in journeys, out of the coverable set, never entry points */
  plumbing?: string[];
  /** node ids (or name matchers, the guards shape) of the functions that build the process container — the setup closure's roots */
  setup?: string[];
  /**
   * glob(s) of tooling — scripts a person runs by hand, not the running app. Their nodes are
   * tagged `tooling`, a call from the app into one is demoted to LOW confidence, and a journey
   * never walks into one. Default `DEFAULT_TOOLING` (`["scripts/**"]`); `[]` turns it off.
   */
  tooling?: string[];
  /** the repo's Storybook(s) — where the config lives and where it runs when it runs (ADR 9). Discovery of `.storybook/main.*` still runs; this names the URL and the start command. */
  storybook?: StorybookConfig | StorybookConfig[];
  /** how the workspace's project tags group: dimensions added or renamed, and words for tag values (docs/proposals/dependencies-and-nx.md §2.2) */
  projects?: ProjectsConfig;
  /**
   * How the journeys are organised: personas and groups in the order they are shown, and a flow's
   * placement by id (docs/proposals/journey-organisation-and-config-files.md §4.2). The root file's
   * block applies to every manifest of the source, a nested file's to the manifests under its folder.
   */
  journeys?: JourneysConfig;
  /**
   * The words people use for a record's statuses, per persona, and the conditions they see that are
   * not statuses (round 2026-10-10 §3). Keyed by the record's node id or table name. The code decides
   * the statuses and the moves; this only names them — a status the code does not declare is a note.
   */
  lifecycle?: Record<string, LifecycleConfigEntry>;
  /**
   * Decisions the team made or left open, by id — the same shape as a manifest's `decisions[]` (core decisions.ts),
   * every field but the id optional: an entry overrides a manifest's decision field by field, root file first and the
   * nearest nested file last, and an id no manifest declares is declared here. A nested file's `doc` is relative to
   * its folder.
   */
  decisions?: DecisionConfigEntry[];
}

/** `farsight.config.json → decisions[]`: a decision by id, every other field optional (an override gives only what it changes). */
export type DecisionConfigEntry = Partial<Omit<DecisionDecl, 'id'>> & { id: string };

/** The fields a farsight.config.json may give, in the order the docs list them. Any other key is ignored with a note. */
export const CONFIG_FIELDS = [
  'tags',
  'glossary',
  'guards',
  'gateTiers',
  'entrypoints',
  'setup',
  'plumbing',
  'design',
  'openapi',
  'tests',
  'storybook',
  'externals',
  'frameworks',
  'patterns',
  'nodes',
  'stores',
  'journeys',
  'projects',
  'tooling',
  'lifecycle',
  'decisions',
  'internalRoutes',
  'validators',
] as const satisfies readonly (keyof FarsightConfig)[];

/** Fields only the source's root farsight.config.json may give; a nested file's value is ignored with a note. */
export const ROOT_ONLY_CONFIG_FIELDS = [
  'frameworks',
  'projects',
  'tooling',
  'internalRoutes',
  'validators',
] as const satisfies readonly (keyof FarsightConfig)[];

/** `farsight.config.json → journeys`: the same shapes as a manifest's, every field but the id optional (an override gives only what it changes). */
export interface JourneysConfig {
  personas?: JourneysConfigPersona[];
  groups?: JourneysConfigGroup[];
  flows?: JourneysConfigFlow[];
  /** storylines — named chains of journeys (round-2026-10-05 §2); an entry overrides the manifest's with the same id, field by field */
  storylines?: JourneysConfigStoryline[];
}
export interface JourneysConfigStoryline {
  id: string;
  name?: string;
  description?: string;
  journeys?: (string | JourneyStorylineEntryDecl)[];
  lanes?: JourneyStorylineLaneDecl[];
  handoffs?: JourneyStorylineHandoffDecl[];
}
export interface JourneysConfigPersona {
  id: string;
  name?: string;
  description?: string;
  routes?: string[];
  signsInWith?: string[];
}
export interface JourneysConfigGroup {
  id: string;
  name?: string;
  description?: string;
  persona?: string;
}
export interface JourneysConfigFlow {
  id: string;
  persona?: string | string[];
  group?: string;
  order?: number;
}

/**
 * `farsight.config.json → lifecycle.<record>`: `views[<persona id>][<word>]` lists the statuses that
 * persona calls by that word (`"Being drafted": ["draft"]`); `overlays[]` are conditions a person sees
 * that are not a status — a row in another table (`{ name, table, when }`).
 */
export interface LifecycleConfigEntry {
  views?: Record<string, Record<string, string[]>>;
  overlays?: LifecycleOverlayConfig[];
}
export interface LifecycleOverlayConfig {
  name: string;
  table: string;
  when: string;
}

/**
 * `farsight.config.json → projects`. A dimension with the prefix or the key of a default
 * (`scope:` → domain, `type:` → type, `platform:` → platform) replaces it; any other is added.
 * `tagValues[key][value]` is the word a lens prints for a tag value (`type` → `data-access` → *Data access*).
 */
export interface ProjectsConfig {
  tagDimensions?: TagDimension[];
  tagValues?: Record<string, Record<string, string>>;
  /**
   * A project-graph file NX wrote (`nx graph --file=<path>.json`), source-relative. Read, never
   * produced: Farsight does not run NX. A path that is absolute or climbs out of the source (`..`)
   * is refused with a note (`graphFilePath`); without it the NX cache paths are looked at.
   */
  graphFile?: string;
}

/**
 * A `projects.graphFile` value checked as a path inside the source: relative, no `..` segment, no
 * drive letter or NUL. The containment check against the real source root (symlinks) is the
 * reader's; this one needs no disk. Returns the normalized path, or the sentence that refuses it.
 */
export function graphFilePath(value: string): { path: string } | { note: string } {
  const raw = value.trim();
  const refuse = (why: string) => ({
    note: `projects.graphFile ${JSON.stringify(raw.slice(0, 200))} ${why}, so it is not read.`,
  });
  if (!raw) return refuse('is empty');
  if (raw.includes('\0')) return refuse('holds a NUL character');
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p))
    return refuse('is an absolute path; it must name a file inside the source');
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (parts.includes('..')) return refuse('climbs out of the source with ..');
  if (!parts.length) return refuse('names no file');
  return { path: parts.join('/') };
}

/** One Storybook, as `farsight.config.json → storybook` declares it. Farsight never starts it. */
export interface StorybookConfig {
  /** repo-relative `.storybook` directory; matched against the discovered ones (default: the only one found) */
  configDir?: string;
  /** where it is served when it runs (`http://localhost:6006`) — the only origin the viewer will frame */
  url?: string;
  /** repo-relative directory its `componentPath`s are relative to (default: the config dir's parent) */
  root?: string;
  /** what a person runs to start it (`npm run storybook`) — printed when it is not reached */
  command?: string;
  name?: string;
}

/** One declared third-party system: the client the calls go through, what to call it, and what kind of system it is. */
export type { ExternalDecl } from '@farsight/graph';
import type { ExternalDecl } from '@farsight/graph';

/**
 * One declared data store (`farsight.config.json → stores[]`). Without `tables` it names the store of every
 * table the code left unnamed; with `tables` it names only those (by table name). Code always wins.
 */
export interface StoreDecl {
  name: string;
  kind: StoreKind;
  engine?: StoreEngine;
  tables?: string[];
}

/** Where one level's results/coverage reports live. Paths are repo-relative globs; the adapter never runs tests. */
export interface TestReportConfig {
  runner?: 'vitest' | 'jest' | 'node:test' | 'playwright' | 'cypress' | 'junit' | 'other';
  /** per-case status/duration: a vitest `json` reporter file, a playwright `json` reporter file, or junit XML — one glob or several */
  results?: string | string[];
  /** istanbul-shaped coverage-final.json — attributed at the run level unless the report names a test; one glob or several */
  coverage?: string | string[];
  /** an html report to deep-link to — one, or one per results file (the one sharing the longest folder with the results file is linked) */
  report?: string | string[];
}

export interface TestsConfigBlock {
  /** extra globs that claim a file as a test (added to the defaults) */
  include?: string[];
  /** globs that un-claim a file the defaults would have taken */
  exclude?: string[];
  /** one block, or one per config file that gave this level (nested farsight.config.json files each keep their own runner) */
  unit?: TestReportConfig | TestReportConfig[];
  integration?: TestReportConfig | TestReportConfig[];
  e2e?: TestReportConfig | TestReportConfig[];
}

/** A config value that may be one string or several, as a list (blank and non-string entries dropped). */
export function stringList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && !!x.trim());
}

/**
 * One farsight.config.json read and soft-validated: the config, or why it could not be read
 * (`missing` when there is no file). Never throws — `loadWorkspaceConfig` turns `error` into a note.
 */
export function readConfigFile(
  path: string,
): { config: FarsightConfig; notes?: string[]; ignored?: string[] } | { error: string } | { missing: true } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { missing: true };
    return { error: `could not be read (${code ?? (err as Error).message})` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `is not valid JSON — ${(err as Error).message.split('\n')[0]}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'is not a JSON object' };
  const config = raw as FarsightConfig;
  const notes: string[] = [];
  const ignored: string[] = [];
  if (config.frameworks !== undefined) {
    const error = configSchemaProblem({ frameworks: config.frameworks }, 'config');
    if (error) {
      delete config.frameworks;
      notes.push(t('config.alias.invalid', 'professional').replace('{error}', error));
      ignored.push('frameworks');
    }
  }
  if (config.nodes !== undefined) {
    const error = configSchemaProblem({ nodes: config.nodes }, 'config');
    if (error) {
      delete config.nodes;
      notes.push(t('config.nodes.invalid', 'professional').replace('{error}', error));
      ignored.push('nodes');
    }
  }
  sanitizeStores(config);
  sanitizeProjects(config);
  sanitizeJourneys(config);
  return { config, ...(notes.length ? { notes, ignored } : {}) };
}

/** Names only, once per configured file; values and match counts stay out of this summary. */
export function frameworkAliasNames(frameworks: FrameworksConfig | undefined): FrameworkAliasSummary | undefined {
  const out: FrameworkAliasSummary = {};
  for (const framework of ['spring', 'nest', 'express'] as const) {
    for (const [group, values] of Object.entries(frameworks?.[framework] ?? {})) {
      const names = Array.isArray(values) ? [...values] : Object.keys(values ?? {});
      if (names.length) out[`${framework}.${group}` as keyof FrameworkAliasSummary] = names.sort();
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** The config at `path`, or null when there is none or it cannot be read (`readConfigFile` says why). */
export function loadConfig(path: string): FarsightConfig | null {
  const r = readConfigFile(path);
  return 'config' in r ? r.config : null;
}

/**
 * One entry of a storyline's `journeys` list, read softly: a non-empty string is a step's flow id; an object with a
 * string `id` keeps its string `branchOf` / `when` / `rejoins` (anything else is left out); everything else is
 * dropped (undefined). The manifest reader and the config sanitizer both read entries through it.
 */
export function storylineEntry(v: unknown): string | JourneyStorylineEntryDecl | undefined {
  const s = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  if (typeof v === 'string') return s(v);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const id = s(o.id);
  if (!id) return undefined;
  return {
    id,
    ...(s(o.branchOf) ? { branchOf: s(o.branchOf)! } : {}),
    ...(s(o.when) ? { when: s(o.when)! } : {}),
    ...(s(o.rejoins) ? { rejoins: s(o.rejoins)! } : {}),
  };
}

/**
 * One `lanes[]` entry of a storyline, read softly (round 2026-10-10 §2): a string `id` and exactly one of a string
 * `persona` or `store`, with an optional `surface` and `name`; anything else is dropped (undefined).
 */
export function storylineLane(v: unknown): JourneyStorylineLaneDecl | undefined {
  const s = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const id = s(o.id),
    persona = s(o.persona),
    store = s(o.store);
  if (!id || (!persona && !store) || (persona && store)) return undefined;
  return {
    id,
    ...(persona ? { persona } : {}),
    ...(store ? { store } : {}),
    ...(s(o.surface) ? { surface: s(o.surface)! } : {}),
    ...(s(o.name) ? { name: s(o.name)! } : {}),
  };
}

/**
 * One `handoffs[]` entry of a storyline, read softly (round 2026-10-10 §2): string `from` and `to`, a `kind` of
 * `moves` or `seen`, an optional `status` and `when`; anything else is dropped (undefined).
 */
export function storylineHandoff(v: unknown): JourneyStorylineHandoffDecl | undefined {
  const s = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const from = s(o.from),
    to = s(o.to),
    kind = s(o.kind);
  if (!from || !to || (kind !== 'moves' && kind !== 'seen')) return undefined;
  return {
    from,
    to,
    kind,
    ...(s(o.status) ? { status: s(o.status)! } : {}),
    ...(s(o.when) ? { when: s(o.when)! } : {}),
  };
}

/**
 * Soft validation of `journeys` (§4.2): an entry without a string id is dropped, a field of the
 * wrong type is left out, a block of the wrong shape becomes empty. Never throws.
 */
export function sanitizeJourneys(config: FarsightConfig): FarsightConfig {
  if (config.journeys === undefined) return config;
  const raw = config.journeys as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    delete config.journeys;
    return config;
  }
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const entries = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).filter(
      (e): e is Record<string, unknown> =>
        !!e && typeof e === 'object' && !Array.isArray(e) && !!str((e as Record<string, unknown>).id),
    );
  // a list of non-empty strings (a lone string is a list of one); absent or empty: undefined
  const strList = (v: unknown): string[] | undefined => {
    const list = (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []).map(str).filter((x): x is string => !!x);
    return list.length ? list : undefined;
  };
  const out: JourneysConfig = {};
  if (r.personas !== undefined) {
    out.personas = entries(r.personas).map((e) => ({
      id: str(e.id)!,
      ...(str(e.name) ? { name: str(e.name)! } : {}),
      ...(str(e.description) ? { description: str(e.description)! } : {}),
      ...(strList(e.routes) ? { routes: strList(e.routes)! } : {}),
      ...(strList(e.signsInWith) ? { signsInWith: strList(e.signsInWith)! } : {}),
    }));
  }
  if (r.groups !== undefined) {
    out.groups = entries(r.groups).map((e) => ({
      id: str(e.id)!,
      ...(str(e.name) ? { name: str(e.name)! } : {}),
      ...(str(e.description) ? { description: str(e.description)! } : {}),
      ...(str(e.persona) ? { persona: str(e.persona)! } : {}),
    }));
  }
  if (r.flows !== undefined) {
    out.flows = entries(r.flows).map((e) => {
      const persona = Array.isArray(e.persona) ? e.persona.map(str).filter((x): x is string => !!x) : str(e.persona);
      return {
        id: str(e.id)!,
        ...(persona !== undefined && (!Array.isArray(persona) || persona.length) ? { persona } : {}),
        ...(str(e.group) ? { group: str(e.group)! } : {}),
        ...(typeof e.order === 'number' && Number.isFinite(e.order) ? { order: e.order } : {}),
      };
    });
  }
  if (r.storylines !== undefined) {
    out.storylines = entries(r.storylines).map((e) => {
      const journeys = Array.isArray(e.journeys)
        ? e.journeys.map(storylineEntry).filter((x): x is string | JourneyStorylineEntryDecl => !!x)
        : undefined;
      return {
        id: str(e.id)!,
        ...(str(e.name) ? { name: str(e.name)! } : {}),
        ...(str(e.description) ? { description: str(e.description)! } : {}),
        ...(journeys ? { journeys } : {}),
        ...(Array.isArray(e.lanes)
          ? { lanes: e.lanes.map(storylineLane).filter((x): x is JourneyStorylineLaneDecl => !!x) }
          : {}),
        ...(Array.isArray(e.handoffs)
          ? { handoffs: e.handoffs.map(storylineHandoff).filter((x): x is JourneyStorylineHandoffDecl => !!x) }
          : {}),
      };
    });
  }
  config.journeys = out;
  return config;
}

const STORE_KINDS: readonly StoreKind[] = ['sql', 'document', 'files', 'erp', 'other'];
const STORE_ENGINES: readonly StoreEngine[] = ['postgres', 'mysql', 'sqlite', 'mssql', 'mongodb'];

/**
 * Soft validation of the data-store fields (docs/proposals/data-stores.md §3.1): a `stores[]`
 * entry without a name or with an unknown kind is dropped, an unknown engine or a non-string
 * table is left out, a non-boolean `externals[].store` is ignored. Never throws — a config
 * mistake leaves the store unnamed, which the graph says, rather than failing the ingest.
 */
export function sanitizeStores(config: FarsightConfig): FarsightConfig {
  if (config.stores !== undefined) {
    const raw: unknown[] = Array.isArray(config.stores) ? config.stores : [];
    const out: StoreDecl[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const d = r as Record<string, unknown>;
      if (typeof d.name !== 'string' || !d.name.trim() || !STORE_KINDS.includes(d.kind as StoreKind)) continue;
      const tables = Array.isArray(d.tables)
        ? d.tables.filter((t): t is string => typeof t === 'string' && !!t)
        : undefined;
      out.push({
        name: d.name.trim(),
        kind: d.kind as StoreKind,
        ...(STORE_ENGINES.includes(d.engine as StoreEngine) ? { engine: d.engine as StoreEngine } : {}),
        ...(tables ? { tables } : {}),
      });
    }
    config.stores = out;
  }
  if (Array.isArray(config.externals)) {
    for (const e of config.externals) {
      if (e && typeof e === 'object' && 'store' in e && typeof e.store !== 'boolean')
        delete (e as { store?: unknown }).store;
    }
  }
  return config;
}

/**
 * Soft validation of `projects` (docs/proposals/dependencies-and-nx.md §2.2): a dimension without a
 * string key, prefix and label is dropped, a tag value word that is not a non-empty string is left out,
 * and a block of the wrong shape becomes empty. Never throws — a config mistake leaves the default
 * dimensions and the humanized values in place.
 */
export function sanitizeProjects(config: FarsightConfig): FarsightConfig {
  if (config.projects === undefined) return config;
  const raw = config.projects as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    delete config.projects;
    return config;
  }
  const r = raw as Record<string, unknown>;
  const out: ProjectsConfig = {};
  if (Array.isArray(r.tagDimensions)) {
    const dims: TagDimension[] = [];
    for (const d of r.tagDimensions) {
      if (!d || typeof d !== 'object') continue;
      const { key, prefix, label } = d as Record<string, unknown>;
      if (typeof key !== 'string' || !key.trim() || typeof prefix !== 'string' || !prefix.trim()) continue;
      dims.push({
        key: key.trim(),
        prefix: prefix.trim(),
        label: typeof label === 'string' && label.trim() ? label.trim() : key.trim(),
      });
    }
    if (dims.length) out.tagDimensions = dims;
  }
  if (r.tagValues && typeof r.tagValues === 'object' && !Array.isArray(r.tagValues)) {
    const values: Record<string, Record<string, string>> = {};
    for (const [key, words] of Object.entries(r.tagValues as Record<string, unknown>)) {
      if (!words || typeof words !== 'object' || Array.isArray(words)) continue;
      const kept = Object.entries(words as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim(),
      );
      if (kept.length) values[key] = Object.fromEntries(kept.map(([v, w]) => [v, w.trim()]));
    }
    if (Object.keys(values).length) out.tagValues = values;
  }
  // kept as written when it is a string; graphFilePath() refuses an escape where a note can be recorded
  if (typeof r.graphFile === 'string' && r.graphFile.trim()) out.graphFile = r.graphFile.trim();
  config.projects = out;
  return config;
}

const ROUTE_MATCHER = /^([A-Z]+) (\/\S*)$/;

/** `{token}` / `:token` / `${x}` → one shape, so a config matcher meets a route however the adapter spelled it. */
function routeKey(name: string): string {
  return name
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/:[A-Za-z_]+/g, ':p')
    .replace(/\{[^}/]+\}/g, ':p')
    .replace(/\/$/, '');
}

/**
 * Glob → RegExp for config path globs (`plumbing: ["libs/api/http/**"]`).
 * The same tokenizer as `testGlobToRegExp` in `parsers/src/tests/cases.ts`,
 * duplicated here because core cannot import parsers: `shared/files.ts`'s
 * rewrite order collapses a leading `**` + `/` into a single segment, which a
 * `src/plumbing/**` claim cannot live with. Line comments only around it.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  const chars = [...glob];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === '*') {
      if (chars[i + 1] === '*') {
        i++;
        if (chars[i + 1] === '/') {
          i++;
          out += '(?:[^/]+/)*';
        } else out += '.*';
      } else out += '[^/]*';
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}(?:/.*)?$`);
}

/**
 * Route-shaped guard matchers → a `declared` guard node per label + a guards
 * edge onto every route it names. Idempotent (runs before the OpenAPI
 * post-pass so drift sees the gate, and again after it for the routes the
 * spec added). Config-declared gates are tagged `declared`: they are a
 * statement about the system, not something the parser observed.
 */
export function applyRouteGuards(
  nodes: GraphNode[],
  config: FarsightConfig,
  edges: GraphEdge[],
  scope?: ConfigScope,
  index = new DeclaredNodeIndex(nodes, edges),
): number {
  let added = 0;
  const byId = index.byId;
  for (const [label, matchers] of Object.entries(config.guards ?? {})) {
    const routes = matchers
      .map((m) => m.match(ROUTE_MATCHER))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => `${m[1]} ${routeKey(m[2]!)}`);
    if (!routes.length) continue;
    const candidates = new Set(routes.flatMap((key) => index.routeGuards.get(key) ?? []));
    for (const node of [...candidates].sort((a, b) => index.order.get(a.id)! - index.order.get(b.id)!)) {
      if (scope && !scope(node)) continue;
      const mp = node.name.match(ROUTE_MATCHER);
      if (!mp || !routes.includes(`${mp[1]} ${routeKey(mp[2]!)}`)) continue;
      const repo = node.loc?.repo ?? node.id.split('::')[0]!;
      const manualId = `${repo}::guard::${label}`;
      const manual = byId.get(manualId);
      const guard = manual?.kind === 'guard' ? manual : configGuard(nodes, index, repo, label);
      if (index.hasEdge('guards', guard.id, node.id)) continue;
      const edge: GraphEdge = {
        id: `cfg-guard-${edges.length}`,
        kind: 'guards',
        from: guard.id,
        to: node.id,
        resolution: { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' },
      };
      edges.push(edge);
      index.addEdge(edge);
      added++;
    }
  }
  return added;
}

/** Tooling roots when `farsight.config.json` names none: a repo's top-level `scripts/`. */
export const DEFAULT_TOOLING: readonly string[] = ['scripts/**'];

/**
 * Tag tooling nodes and demote the app's edges into them, in place. A script and the
 * running app can share a function name, and a heuristic (a hook bound at
 * `new Worker({ log })` in a script, a name match) then draws the script on a production
 * path with the confidence of a real call. A call *from* a script into the app is real and
 * kept as it is; a call from the app *into* a script becomes LOW with a note saying why,
 * and `journey()` does not follow it. Runs whether or not the repo has a config file.
 * Returns how many edges it demoted.
 */
export function applyTooling(
  nodes: GraphNode[],
  edges: GraphEdge[],
  globs: readonly string[] = DEFAULT_TOOLING,
): number {
  if (!globs.length) return 0;
  const res = globs.map(globToRegExp);
  const tooling = new Set<string>();
  for (const node of nodes) {
    const p = node.loc?.path;
    if (!p || !res.some((re) => re.test(p))) continue;
    if (!node.tags.includes('tooling')) node.tags.push('tooling');
    tooling.add(node.id);
  }
  if (!tooling.size) return 0;
  let demoted = 0;
  for (const e of edges) {
    if (!tooling.has(e.to) || tooling.has(e.from)) continue;
    if (e.meta?.tooling) continue;
    const r = e.resolution;
    const note = `the target is tooling (${globs.join(', ')}) — a script, not the running app`;
    e.resolution = {
      status: r?.status === 'unresolved' ? 'unresolved' : 'heuristic',
      technique: r?.technique ?? 'name-match',
      confidence: 'LOW',
      ...(r?.candidates ? { candidates: r.candidates } : {}),
      ...(r?.alternatives ? { alternatives: r.alternatives } : {}),
      note: r?.note ? `${r.note}; ${note}` : note,
    };
    e.meta = { ...e.meta, tooling: true };
    demoted++;
  }
  return demoted;
}

/**
 * The glossary entry for one node name. Exact name first; for a `Class.method` name,
 * then the member part (`claimNext`), then the class part (`BcOutboxWorker`) — a class
 * entry labels each member as the class's words and the member humanized
 * (`Business Central outbox worker: drain once`), never the bare class label, and does
 * not lend the class's description to a member it does not describe.
 */
export function glossaryEntryFor(
  name: string,
  glossary: FarsightConfig['glossary'],
): { label: string; description?: string } | undefined {
  if (!glossary) return undefined;
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(glossary, k) ? glossary[k] : undefined);
  const exact = own(name);
  if (exact) return exact;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1 || name.includes(' ')) return undefined;
  const member = name.slice(dot + 1);
  const byMember = own(member);
  if (byMember) return byMember;
  const cls = name.slice(0, dot);
  const byClass = own(cls) ?? (cls.includes('.') ? own(cls.slice(cls.lastIndexOf('.') + 1)) : undefined);
  if (byClass) return { label: `${byClass.label}: ${humanizeName(member).toLowerCase()}` };
  return undefined;
}

/**
 * Which nodes one config file speaks for. The root farsight.config.json speaks for every node
 * (no scope); a nested one only for the nodes under its folder (`scopeOfDir`).
 */
export type ConfigScope = (node: GraphNode) => boolean;

/** The scope of a nested config file at repo-relative `dir`: nodes whose `loc.path` is under `dir/`. `''` = the root = every node. */
export function scopeOfDir(dir: string): ConfigScope | undefined {
  const d = dir
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
  if (!d || d === '.') return undefined;
  const prefix = `${d}/`;
  return (node) => !!node.loc?.path && node.loc.path.replace(/\\/g, '/').startsWith(prefix);
}

export interface ApplyConfigOptions {
  /** Source identity is required when the adapters produced no nodes. */
  repo?: string;
  /** Config folder and display provenance; workspace overlays use their settings label. */
  dir?: string;
  from?: string;
  /** Confirm a repo-relative location exists inside the selected source. */
  hasFile?: (path: string) => boolean;
  /** Shared across a workspace pass; additions are indexed as they happen. */
  declaredIndex?: DeclaredNodeIndex;
  /** only these nodes (a nested config file's folder); every node when absent */
  scope?: ConfigScope;
  /**
   * Functions an earlier config file already turned into guards. A guard rule of this file that
   * matches one of them does not rename it again (the rename is not idempotent) — `onGuardConflict` hears it.
   */
  guarded?: ReadonlySet<string>;
  onGuardConflict?: (node: GraphNode, label: string) => void;
}

/** What one `applyConfig` call did that the next file needs to know. */
export interface ApplyConfigResult {
  /** node ids this call turned from a function into a guard */
  guarded: string[];
}

/** Apply tag rules, plumbing/setup tags, glossary facets, and declared guards/entrypoints to a fragment, in place. */
export function applyConfig(
  nodes: GraphNode[],
  config: FarsightConfig,
  edges: GraphEdge[] = [],
  options: ApplyConfigOptions = {},
): ApplyConfigResult {
  const index = options.declaredIndex ?? new DeclaredNodeIndex(nodes, edges);
  options = { ...options, declaredIndex: index };
  const declared = applyDeclaredNodes(nodes, config, options);
  const scope = options.scope ? (node: GraphNode) => declared.has(node.id) || options.scope!(node) : undefined;
  const { guarded: already } = options;
  const guarded: string[] = [];
  const tagRules = Object.entries(config.tags ?? {});
  // function-shaped matchers only here; route-shaped ones are applyRouteGuards()
  const guardRules = Object.entries(config.guards ?? {})
    .map(([l, ms]) => [l, ms.filter((m) => !ROUTE_MATCHER.test(m))] as const)
    .filter(([, ms]) => ms.length);
  const entryRules = Object.entries(config.entrypoints ?? {});
  const tierRules = Object.entries(config.gateTiers ?? {});
  // plumbing is a path glob (a whole directory of helpers); setup is the guards' matcher shape (an exact node id or a substring of `path name`)
  const plumbingGlobs = (config.plumbing ?? []).map(globToRegExp);
  const setupMatchers = config.setup ?? [];
  for (const node of nodes) {
    if (scope && !scope(node)) continue;
    const hay = `${node.loc?.path ?? ''} ${node.name}`.toLowerCase();
    for (const [tag, matchers] of tagRules) {
      if (!node.tags.includes(tag) && matchers.some((m) => hay.includes(m.toLowerCase()))) {
        node.tags.push(tag);
      }
    }
    // helpers by declaration: plumbing folds in journeys and leaves the coverable set regardless of @business
    if (!node.tags.includes('plumbing') && node.loc?.path && plumbingGlobs.some((re) => re.test(node.loc!.path))) {
      node.tags.push('plumbing');
    }
    // the setup closure's roots — an exact node id, or (functions only) the guards' substring matcher
    if (
      !node.tags.includes('setup') &&
      setupMatchers.some((m) => node.id === m || (node.kind === 'function' && hay.includes(m.toLowerCase())))
    ) {
      node.tags.push('setup');
    }
    // before guard rules — they rename the node. A guard the adapter already found carries
    // `name: label`; its glossary key is the identifier before the colon.
    const colon = node.kind === 'guard' ? node.name.indexOf(': ') : -1;
    const entry = glossaryEntryFor(colon > 0 ? node.name.slice(0, colon) : node.name, config.glossary);
    if (entry) {
      // the glossary's words win; a description the code wrote stays where the glossary gives none
      node.facets = { ...node.facets, business: { ...node.facets?.business, ...entry } };
    }
    for (const [label, matchers] of guardRules) {
      if (!matchers.some((m) => hay.includes(m.toLowerCase()))) continue;
      if (already?.has(node.id)) {
        options.onGuardConflict?.(node, label);
        continue;
      }
      if (node.kind !== 'function') continue;
      node.kind = 'guard';
      guarded.push(node.id);
      node.name = `${node.name}: ${label}`;
      index.addNode(node);
      if (!node.tags.includes('auth')) node.tags.push('auth');
      // calls into the wrapper gain a guards edge pointing back at the caller; the calls edge stays,
      // because the wrapper is also run — what it does inside (its reads, writes, calls) is part of the walk
      for (const e of index.callsInto.get(node.id) ?? []) {
        if (index.hasEdge('guards', node.id, e.from)) continue;
        const edge: GraphEdge = {
          id: `g${edges.length}`,
          kind: 'guards',
          from: node.id,
          to: e.from,
          resolution: {
            status: 'resolved',
            technique: 'annotation-scan',
            confidence: 'HIGH',
            note: `declared a guard by farsight.config.json (${label})`,
          },
        };
        edges.push(edge);
        index.addEdge(edge);
        e.meta = { ...e.meta, via: 'guard' };
      }
    }
    // the tier a team gives a gate, past its class (core gate-class.ts); the code's own `@guard[tier]` stands
    if ((node.kind === 'guard' || node.kind === 'rule') && node.gateTier?.from !== 'annotation') {
      for (const [m, tier] of tierRules) {
        if (!(node.id === m || hay.includes(m.toLowerCase()))) continue;
        if (tier !== 'business' && tier !== 'policy' && tier !== 'technical') continue;
        node.gateTier = { tier, from: 'config' };
      }
    }
    for (const [label, matchers] of entryRules) {
      if (matchers.some((m) => hay.includes(m.toLowerCase()))) {
        for (const t of ['entrypoint', label]) if (!node.tags.includes(t)) node.tags.push(t);
      }
    }
  }
  applyRouteGuards(nodes, config, edges, scope, index);
  applyDeclaredNodeEdges(nodes, edges, config, options);
  applyDeclaredGuardGrants(nodes, edges, config, options);
  return { guarded };
}

/** Apply explicit manual grants after guard connections exist, including connections from later config/spec passes. */
export function applyDeclaredGuardGrants(
  nodes: GraphNode[],
  edges: GraphEdge[],
  config: FarsightConfig,
  options: ApplyConfigOptions = {},
): void {
  const repo = options.repo ?? nodes[0]?.loc?.repo ?? nodes[0]?.id.split('::')[0];
  if (!repo || !config.nodes?.length) return;
  const index = options.declaredIndex ?? new DeclaredNodeIndex(nodes, edges);
  for (const decl of config.nodes) {
    if (decl.kind !== 'guard' || !decl.requires?.trim()) continue;
    const id = `${repo}::guard::${decl.name}`;
    const guard = index.byId.get(id);
    if (!guard || (guard.loc && options.scope && !options.scope(guard))) continue;
    for (const edge of index.guardsFrom.get(id) ?? []) {
      if (edge.meta?.requires) continue;
      edge.meta = {
        ...edge.meta,
        requires: decl.requires,
        requiresFrom: `${options.from ?? 'farsight.config.json'} → nodes[${decl.name}]`,
      };
    }
  }
}

/** A declared path stays inside its config folder; it never causes a file read. */
export function declaredNodePath(value: string, dir = '.'): string | undefined {
  const raw = value.replace(/\\/g, '/');
  if (!raw.trim() || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) return undefined;
  const path = posix.normalize(posix.join(dir, raw));
  if (path === '..' || path.startsWith('../') || (dir !== '.' && !path.startsWith(`${dir}/`))) return undefined;
  return path.replace(/^\.\//, '');
}

/** One mutable index for declaration matching and connections, shared across each workspace pass. */
export class DeclaredNodeIndex {
  readonly byId = new Map<string, GraphNode>();
  readonly routes = new Map<string, Map<string, GraphNode>>();
  readonly routeGuards = new Map<string, GraphNode[]>();
  readonly order = new Map<string, number>();
  readonly handlers = new Map<string, Set<GraphNode>>();
  readonly guardLabels = new Map<string, Set<GraphNode>>();
  readonly guardsFrom = new Map<string, GraphEdge[]>();
  readonly callsInto = new Map<string, GraphEdge[]>();
  readonly files = new Set<string>();
  private readonly edgeKeys = new Set<string>();

  constructor(nodes: GraphNode[], edges: GraphEdge[] = []) {
    for (const node of nodes) this.addNode(node);
    for (const edge of edges) this.addEdge(edge);
  }

  addNode(node: GraphNode): void {
    const fresh = !this.byId.has(node.id);
    if (fresh) this.order.set(node.id, this.order.size);
    this.byId.set(node.id, node);
    const repo = node.loc?.repo ?? node.id.split('::')[0]!;
    if (node.loc) {
      this.files.add(node.loc.path);
      const key = `${repo}::${node.loc.path}::${node.name.split(': ')[0]}`;
      const bucket = this.handlers.get(key) ?? new Set<GraphNode>();
      bucket.add(node);
      this.handlers.set(key, bucket);
    }
    const route = node.kind === 'route' && declaredRouteKey(node.name);
    if (route) {
      if (fresh) {
        const match = node.name.match(ROUTE_MATCHER)!;
        const key = `${match[1]} ${routeKey(match[2]!)}`;
        const targets = this.routeGuards.get(key) ?? [];
        targets.push(node);
        this.routeGuards.set(key, targets);
      }
      const bucket = this.routes.get(route) ?? new Map<string, GraphNode>();
      if (!bucket.has(repo)) bucket.set(repo, node);
      this.routes.set(route, bucket);
    }
    if (node.kind === 'guard' && node.name.includes(': ')) {
      const key = `${repo}::${node.name.slice(node.name.indexOf(': ') + 2)}`;
      const bucket = this.guardLabels.get(key) ?? new Set<GraphNode>();
      bucket.add(node);
      this.guardLabels.set(key, bucket);
    }
  }

  hasEdge(kind: GraphEdge['kind'], from: string, to: string): boolean {
    return this.edgeKeys.has(JSON.stringify([kind, from, to]));
  }

  addEdge(edge: GraphEdge): void {
    this.edgeKeys.add(JSON.stringify([edge.kind, edge.from, edge.to]));
    const map = edge.kind === 'guards' ? this.guardsFrom : edge.kind === 'calls' ? this.callsInto : undefined;
    if (!map) return;
    const key = edge.kind === 'guards' ? edge.from : edge.to;
    const bucket = map.get(key) ?? [];
    bucket.push(edge);
    map.set(key, bucket);
  }
}

/** An exact id, or one unambiguous declaration in the named file. No guessed or placeholder targets. */
export function declaredNodeHandler(
  index: DeclaredNodeIndex,
  ref: string,
  repo: string,
  dir = '.',
  scope = scopeOfDir(dir),
): GraphNode | undefined {
  const exact = index.byId.get(ref);
  if (exact && (exact.loc?.repo ?? exact.id.split('::')[0]) === repo && (!scope || scope(exact))) return exact;
  const parts = ref.split('::');
  if (parts.length !== 2) return undefined;
  const path = declaredNodePath(parts[0]!, dir);
  if (!path) return undefined;
  const found = [...(index.handlers.get(`${repo}::${path}::${parts[1]}`) ?? [])].filter((n) => !scope || scope(n));
  return found.length === 1 ? found[0] : undefined;
}

/** Labels refer to hand-made guards or guards produced by this config's existing guard rules. */
export function declaredNodeGuards(
  index: DeclaredNodeIndex,
  label: string,
  config: FarsightConfig,
  repo: string,
  scope?: ConfigScope,
): GraphNode[] {
  const found = new Set<GraphNode>();
  for (const id of [`${repo}::guard::${label}`, `${repo}::guard::config:${label}`]) {
    const node = index.byId.get(id);
    if (node?.kind === 'guard') found.add(node);
  }
  const matchers = config.guards?.[label];
  if (matchers)
    for (const node of index.guardLabels.get(`${repo}::${label}`) ?? []) {
      if (
        (!scope || scope(node)) &&
        matchers.some(
          (m) =>
            !ROUTE_MATCHER.test(m) && `${node.loc?.path ?? ''} ${node.name}`.toLowerCase().includes(m.toLowerCase()),
        )
      )
        found.add(node);
    }
  return [...found];
}

function declaredRouteKey(name: string): string | undefined {
  const match = /^([A-Z]+) (\/\S*)$/.exec(name);
  return match ? `${match[1]} ${normalizeRoutePath(match[2]!)}` : undefined;
}

export function declaredNodeTarget(index: DeclaredNodeIndex, decl: NodeDecl, repo: string): GraphNode | undefined {
  if (decl.kind === 'route') return index.routes.get(declaredRouteKey(decl.name) ?? '')?.get(repo);
  const node = index.byId.get(`${repo}::${decl.kind}::${decl.name}`);
  return node?.kind === decl.kind ? node : undefined;
}

function applyDeclaredNodes(nodes: GraphNode[], config: FarsightConfig, options: ApplyConfigOptions): Set<string> {
  const ids = new Set<string>();
  const repo = options.repo ?? nodes[0]?.loc?.repo ?? nodes[0]?.id.split('::')[0];
  if (!repo) return ids;
  const index = options.declaredIndex!;
  for (const decl of config.nodes ?? []) {
    if (!['route', 'guard', 'external', 'queue'].includes(decl.kind) || !decl.name?.trim()) continue;
    if (decl.kind === 'route' && !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|ALL) \/\S*$/.test(decl.name))
      continue;
    let node = declaredNodeTarget(index, decl, repo);
    // A nested declaration cannot augment a reader's route outside its own folder; the audit explains it.
    if (node && options.scope && node.loc && !options.scope(node)) continue;
    const created = !node;
    if (!node) {
      node = { id: `${repo}::${decl.kind}::${decl.name}`, kind: decl.kind, name: decl.name, tags: ['declared'] };
      if (decl.kind === 'guard') node.tags.push('auth');
      nodes.push(node);
    }
    ids.add(node.id);
    const loc = decl.loc?.match(/^(.*):([1-9]\d*)$/);
    const path = loc && declaredNodePath(loc[1]!, options.dir);
    if (created && path && (options.hasFile?.(path) ?? index.files.has(path)))
      node.loc = { repo, path, line: Number(loc![2]) };
    if (decl.business && !node.facets?.business?.description)
      node.facets = { ...node.facets, business: { ...node.facets?.business, description: decl.business } };
    if (decl.kind === 'guard' && decl.tier && !node.gateTier) node.gateTier = { tier: decl.tier, from: 'config' };
    index.addNode(node);
  }
  return ids;
}

function configGuard(nodes: GraphNode[], index: DeclaredNodeIndex, repo: string, label: string): GraphNode {
  const id = `${repo}::guard::config:${label}`;
  const existing = index.byId.get(id);
  if (existing) return existing;
  const guard: GraphNode = {
    id,
    kind: 'guard',
    name: label,
    tags: ['auth', 'declared'],
    facets: { business: { description: t('config.nodes.guardDescription', 'professional').replace('{label}', label) } },
  };
  nodes.push(guard);
  index.addNode(guard);
  return guard;
}

function applyDeclaredNodeEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
  config: FarsightConfig,
  options: ApplyConfigOptions,
): void {
  const repo = options.repo ?? nodes[0]?.loc?.repo ?? nodes[0]?.id.split('::')[0];
  if (!repo) return;
  const index = options.declaredIndex!;
  const from = options.from ?? 'farsight.config.json';
  const link = (kind: 'calls' | 'guards', source: string, target: string) => {
    if (source === target || index.hasEdge(kind, source, target)) return;
    const edge: GraphEdge = {
      id: `declared|${kind}|${source}|${target}`,
      kind,
      from: source,
      to: target,
      resolution: {
        status: 'resolved',
        technique: 'annotation-scan',
        confidence: 'HIGH',
        note: t('config.nodes.evidence', 'professional').replace('{from}', from),
      },
    };
    edges.push(edge);
    index.addEdge(edge);
  };
  for (const decl of config.nodes ?? []) {
    if (decl.kind !== 'route') continue;
    const route = declaredNodeTarget(index, decl, repo);
    if (!route || (options.scope && route.loc && !options.scope(route))) continue;
    const handler = decl.handler && declaredNodeHandler(index, decl.handler, repo, options.dir, options.scope);
    if (handler) link('calls', route.id, handler.id);
    for (const label of decl.guards ?? []) {
      const guards = declaredNodeGuards(index, label, config, repo, options.scope);
      if (!guards.length && Object.hasOwn(config.guards ?? {}, label))
        guards.push(configGuard(nodes, index, repo, label));
      for (const guard of guards) link('guards', guard.id, route.id);
    }
  }
}

/** Edge kinds that carry the setup origin outward from the closure — everything a container build actually does. */
const SETUP_ORIGIN_KINDS = new Set<GraphEdge['kind']>([
  'calls',
  'reads',
  'writes',
  'publishes',
  'http',
  'validates',
  'renders',
]);

/**
 * The setup closure and its origin stamp (the clarity-phase plan §2.3.3).
 *
 * `C` starts as the nodes tagged `setup` — the container builders, declared in
 * `farsight.config.json → setup` or found by the parser's `??=` heuristic. It grows
 * until stable: a `function` called from `C` joins only when **every** `calls`
 * in-edge it has comes from `C` (a function with another caller is real work that
 * boot happens to reuse, and stays out). Then every out-edge of a member, and the
 * `calls` in-edge into each setup **root** (`getContainer → build`), is stamped
 * `meta.origin = 'setup'` so `journey()` can print the boot once instead of under
 * every request and `impact_of` can report it separately.
 *
 * In place, additive on `meta`, and idempotent — membership is recomputed from the
 * roots each time and an already-stamped edge is left alone. Returns the number of
 * edges newly stamped.
 */
export function applySetupOrigin(nodes: GraphNode[], edges: GraphEdge[]): number {
  const roots = new Set(nodes.filter((n) => n.tags.includes('setup')).map((n) => n.id));
  if (!roots.size) return 0;
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const outOf = new Map<string, GraphEdge[]>();
  const callsIn = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const out = outOf.get(e.from);
    if (out) out.push(e);
    else outOf.set(e.from, [e]);
    if (e.kind !== 'calls') continue;
    const inc = callsIn.get(e.to);
    if (inc) inc.push(e);
    else callsIn.set(e.to, [e]);
  }
  const closure = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const [to, ins] of callsIn) {
      if (closure.has(to) || kindOf.get(to) !== 'function') continue;
      // reached from the closure, and reached from nowhere else
      if (!ins.some((e) => closure.has(e.from))) continue;
      if (!ins.every((e) => closure.has(e.from))) continue;
      closure.add(to);
      grew = true;
    }
  }
  let stamped = 0;
  const stamp = (e: GraphEdge): void => {
    if (e.meta?.origin === 'setup') return;
    e.meta = { ...e.meta, origin: 'setup' };
    stamped++;
  };
  for (const id of closure) for (const e of outOf.get(id) ?? []) if (SETUP_ORIGIN_KINDS.has(e.kind)) stamp(e);
  for (const id of roots) for (const e of callsIn.get(id) ?? []) stamp(e);
  return stamped;
}
