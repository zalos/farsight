import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename, sep } from 'node:path';
import {
  GraphStore, readModelHubState, rotateEventsFile, journey, journeySummary, resolveEntry, buildIndex, categorizeBranch, SnapshotDb, STRINGS,
  stitchHttp, apiSurface, consumersOf, graphToSpec, reconcile, driftMarkdown,
  designSurface, screensFor, reconcileDesign, designDriftMarkdown, figmaFileKey, designGuide, buildInfo, installState, currencyAdvice,
  storybookLive, storybooksOf, isStorybookUrl, storyCounts,
  testsSurface, testDetail, stepCoverage, verifiedThrough, testsIdentity, testsMatrixV1, testsMatrixCsv,
  impactOf, affectedReach, search, buildLine, projectGraph, projectNodeIds, appClosure, findProject,
  packagesOf, importersOf, resolvePackage, IMPACT_MAX_HOPS,
  diffGraphs, toSarif, toMarkdown, changeSentence, attributeDiffOver, spineRowNote, spineSentences, parseSyncRef, INCOMPLETE_SENTENCE,
  counted,
} from '@farsight/core';
import type { GraphIndex, GraphEdge, GraphNode, JourneyStep, SourceStat, GraphMeta, TestsMeta, CommitSpine, SpineRow, CheckoutFact, ShotInput, ShotRow } from '@farsight/core';
import { refuseRequest } from './guard.js';
import { isSecretRef } from '@farsight/work';
import { writeSpine, syncWork, workSourcesOf, keyOptionsOf, handleWorkRoute } from './work.js';
import type { SourceConfig as WorkSourceConfig, WorkSettingsSource } from './work.js';
import { ingestRepo, ingestSpec, parseSpecText, readSpecSource, specToYaml, isSpecUrl, ingestDesign, readManifestSource, parseManifestText, isManifestUrl, gitHead, gitHeadRef, gitShallow, gitPrefix, GIT_ABSENT_WORD, headTitle, shallowFloorSentence } from '@farsight/parsers';

/**
 * Phase-1.5 app server: viewer + graph + settings/sources API.
 * Grows into the lens-resolving API described in docs/ARCHITECTURE.md
 * (REST control plane + POST /lens/query + WS diffs).
 */

export { writeSpine, resolveCommitNodes, syncWork, joinWork, workSourcesOf, keyOptionsOf, keyDetector, SYNC_MAX_COMMITS } from './work.js';
export type { WorkSettingsSource, WorkSyncOutcome, UnmatchedKey } from './work.js';

export interface Source {
  id: string;
  name: string;
  /** openapi = a spec document as a source of its own (a file, or the URL the API itself serves) — no code · design = a screens manifest as a source of its own (a design-only project) · work = a tracker's work items (Jira, Azure DevOps; docs/proposals/work-items-sync.md §10) */
  type: 'local' | 'git' | 'openapi' | 'design' | 'work';
  /** local: absolute or workspace-relative path. git: clone URL. openapi: spec path or URL. design: manifest path or URL. work: the fixture provider's recorded directory, else unused. */
  path: string;
  // glob patterns skipped during ingest, e.g. ["examples/**"] or test-file globs
  exclude?: string[];
  enabled: boolean;
  /** last sync result, informational */
  status?: string;
  /** where this source's Storybook runs, when the repo's own config or scripts do not say (ADR 9) — overrides the graph's recorded URL */
  storybook?: { url?: string; command?: string };
  // ── type 'work' only (§10). Secrets are never here: `auth.secret` is a `keychain:` reference,
  // because GET /api/settings serves this file back and the viewer rewrites it wholesale ──
  /** registry id: 'jira' | 'azure-devops' | 'fixture' */
  provider?: string;
  /** Jira site URL */
  site?: string;
  /** Azure DevOps organization URL */
  org?: string;
  scope?: WorkSourceConfig['scope'];
  mode?: 'read-only' | 'edit';
  auth?: WorkSourceConfig['auth'];
  /** poll cadence, e.g. '5m' */
  poll?: string;
  fields?: Record<string, string>;
  permissions?: WorkSourceConfig['permissions'];
}

export interface Settings {
  /** `system` (and a settings file that names none) follows the reader's `prefers-color-scheme` */
  theme?: 'dark' | 'light' | 'system';
  defaultLens: 'business' | 'hybrid' | 'code';
  /** role-based landing surface — a default, never a cage: deep links always win */
  defaultSurface?: 'portfolio' | 'journeys' | 'codemap' | 'apis' | 'changes' | 'work';
  sources: Source[];
  /** named selections of source ids, e.g. "Invoice systems" */
  collections: { name: string; sourceIds: string[] }[];
  /**
   * experiments, off unless set. `journeyDrill` adds the action-drill visual to the journey view
   * switch; `designShots` retains each screen's **design** image per sync under
   * `.farsight/cache/shots/` so a past sync can be looked at rather than described. `designShots`
   * writes files, which is why it is opt in — with it unset, the shot pass never runs and the sync
   * writes no bytes beyond the ones it already wrote. `map` adds the `#/map` surface (every journey
   * on one zoomable board) — a nav tab and a Portfolio button; read by the viewer only.
   */
  flags?: { journeyDrill?: boolean; designShots?: boolean; map?: boolean };
}

function settingsPath(ws: string) { return join(ws, '.farsight', 'settings.json'); }
function cacheDir(ws: string) { return join(ws, '.farsight', 'cache'); }

function loadSettings(ws: string): Settings {
  try {
    return JSON.parse(readFileSync(settingsPath(ws), 'utf8'));
  } catch {
    return {
      theme: 'system',
      defaultLens: 'hybrid',
      sources: [{ id: 'workspace', name: basename(resolve(ws)), type: 'local', path: '.', enabled: true }],
      collections: [],
    };
  }
}

const SOURCE_TYPES = new Set(['local', 'git', 'openapi', 'design', 'work']);

/**
 * What PUT /api/settings may write: the shape the server reads back, and no secret
 * value — `auth.secret` must be a `keychain:` / `env:` reference, because GET serves
 * this file to the viewer. Null when the body may be saved; otherwise why not.
 */
export function settingsProblem(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'settings must be a JSON object';
  const s = body as { sources?: unknown; collections?: unknown };
  if (!Array.isArray(s.sources)) return 'settings.sources must be an array';
  if (s.collections !== undefined && !Array.isArray(s.collections)) return 'settings.collections must be an array';
  for (const [i, src] of s.sources.entries()) {
    if (!src || typeof src !== 'object') return `sources[${i}] must be an object`;
    const x = src as { id?: unknown; name?: unknown; type?: unknown; path?: unknown; auth?: { secret?: unknown } };
    if (typeof x.id !== 'string' || !x.id) return `sources[${i}].id must be a non-empty string`;
    if (typeof x.name !== 'string') return `sources[${i}].name must be a string`;
    if (typeof x.type !== 'string' || !SOURCE_TYPES.has(x.type)) return `sources[${i}].type must be one of ${[...SOURCE_TYPES].join(', ')}`;
    if (x.path !== undefined && typeof x.path !== 'string') return `sources[${i}].path must be a string`;
    if (x.type === 'git' && typeof x.path === 'string' && x.path.startsWith('-')) return `sources[${i}].path is not a clone URL`;
    const secret = x.auth?.secret;
    if (secret !== undefined && !(typeof secret === 'string' && isSecretRef(secret))) {
      // never echo it: it may be a pasted token
      return `sources[${i}].auth.secret must be a keychain: or env: reference — secrets never go in settings`;
    }
  }
  return null;
}

function saveSettings(ws: string, s: Settings): void {
  mkdirSync(dirname(settingsPath(ws)), { recursive: true });
  writeFileSync(settingsPath(ws), JSON.stringify(s, null, 2) + '\n');
}

/** Resolve a source to a local directory, cloning/pulling git sources into the cache. */
function materialize(ws: string, source: Source): string {
  if (source.type === 'local') return resolve(ws, source.path);
  const dir = join(cacheDir(ws), source.id);
  if (existsSync(join(dir, '.git'))) {
    execFileSync('git', ['-C', dir, 'pull', '--ff-only', '--quiet'], { timeout: 60_000 });
  } else {
    mkdirSync(cacheDir(ws), { recursive: true });
    // `--`: a clone URL from settings is never read as a git option (`--upload-pack=…`)
    execFileSync('git', ['clone', '--depth', '1', '--quiet', '--', source.path, dir], { timeout: 120_000 });
  }
  return dir;
}

export async function syncSources(ws: string, settings: Settings, graphPath: string) {
  const store = new GraphStore();
  const results: Record<string, string> = {};
  const sourceStats: SourceStat[] = [];
  /** the code checkouts this sync read — their commit spines are written after the graph is built */
  const read: { source: Source; name: string; dir: string }[] = [];
  for (const source of settings.sources) {
    if (!source.enabled) { results[source.id] = 'skipped (disabled)'; continue; }
    // a tracker is not code: its items join the graph after every code source is in (below)
    if (source.type === 'work') continue;
    try {
      if (source.type === 'openapi' || source.type === 'design') {
        // a spec / a screens manifest as a source: declared routes or screens + the api/design node, no code, no root
        const abs = (isSpecUrl(source.path) || isManifestUrl(source.path)) ? source.path : resolve(ws, source.path);
        const fragment = source.type === 'openapi'
          ? await ingestSpec(abs, { repoName: source.name })
          : await ingestDesign(abs, { repoName: source.name });
        store.addFragment(fragment);
        results[source.id] = `ok: ${fragment.nodes.length} nodes, ${fragment.edges.length} edges (${source.type === 'openapi' ? 'spec' : 'design'})`;
        sourceStats.push({ name: source.name, files: 1, status: results[source.id] });
        source.status = results[source.id];
        continue;
      }
      const dir = materialize(ws, source);
      // ingestRepo applies the repo's farsight.config.json itself (before + after the spec pass)
      const fragment = await ingestRepo(dir, { repoName: source.name, exclude: source.exclude });
      store.roots[fragment.repo] = dir;
      store.addFragment(fragment);
      results[source.id] = `ok: ${fragment.nodes.length} nodes, ${fragment.edges.length} edges${fragment.specErrors?.length ? ` · ${fragment.specErrors.join('; ')}` : ''}`;
      // this source's OWN head, not the workspace root's: the snapshot's `commit` column is
      // the workspace's, and a spine that folded it for every source would hand `app-a` the
      // farsight repository's commits. `gitHead` returns undefined when the checkout is not a
      // repository, and the row then honestly records no commit.
      const head = gitHead(dir);
      read.push({ source, name: fragment.repo, dir });
      sourceStats.push({
        name: source.name,
        ...(head ? { commit: head } : {}),
        files: fragment.meta?.files,
        status: results[source.id],
      });
    } catch (err) {
      results[source.id] = `error: ${(err as Error).message.split('\n')[0]}`;
      sourceStats.push({ name: source.name, status: results[source.id] });
    }
    source.status = results[source.id];
  }
  // cross-source HTTP stitching: unresolved fetch stubs → routes any source declares
  stitchHttp(store);
  // work items (docs/proposals/work-items-sync.md §9): every code source's commit spine with the
  // keys its commits name, then the work sources through the engine, then the join into the graph.
  // Fail-soft throughout: a history or a tracker that cannot be read says so on its status line.
  const workSources = workSourcesOf(ws, settings.sources as WorkSettingsSource[]);
  let spineDb: SnapshotDb | undefined;
  try { spineDb = new SnapshotDb(join(ws, '.farsight', 'farsight.db')); } catch (err) {
    for (const r of read) results[r.source.id] += ` · history not indexed: ${(err as Error).message.split('\n')[0]}`;
  }
  let workOutcome: Awaited<ReturnType<typeof syncWork>> | undefined;
  try {
    if (spineDb) {
      const keys = keyOptionsOf(workSources);
      for (const r of read) {
        const said = writeSpine(spineDb, store, { name: r.name, dir: r.dir }, keys);
        if (said) results[r.source.id] += ` · ${said}`;
        r.source.status = results[r.source.id];
      }
    }
    if (workSources.length) {
      workOutcome = await syncWork(ws, workSources, store, spineDb);
      for (const source of settings.sources) {
        if (source.type !== 'work' || !source.enabled) continue;
        results[source.id] = workOutcome.results[source.id] ?? 'skipped';
        source.status = results[source.id];
      }
    }
  } finally {
    spineDb?.close();
  }
  store.meta.workspace = basename(resolve(ws));
  // record history before save so graph.json carries sync/digest/commit/tz;
  // fail-soft: a runtime without node:sqlite still syncs (honest degraded mode)
  let snapshot: string | undefined;
  // the design shots of this sync (chunk H8) — absent unless the workspace asked for them,
  // which is the difference between "the pass found nothing" and "the pass never ran"
  let shots: ShotOutcome | undefined;
  try {
    const db = new SnapshotDb(join(ws, '.farsight', 'farsight.db'));
    const ref = db.write(store, { commit: gitHead(ws), sources: sourceStats });
    snapshot = `sync:${ref.sync} · digest ${ref.digest}`;
    // opt in, and only then: with the flag unset nothing below runs, so this sync
    // writes no shot directory, no shot file and no shot row
    if (settings.flags?.designShots) {
      try { shots = captureShots(ws, db, ref.sync, store); } catch (err) {
        // a retained picture is never worth failing a sync for
        results['design-shots'] = `error: ${(err as Error).message.split('\n')[0]}`;
      }
    }
  } catch (err) {
    snapshot = `history unavailable: ${(err as Error).message.split('\n')[0]}`;
  }
  store.save(graphPath);
  saveSettings(ws, settings);
  return {
    results, stats: store.stats(), snapshot, ...(shots ? { shots } : {}),
    ...(workOutcome ? { work: { reports: workOutcome.reports, nodes: workOutcome.nodes, edges: workOutcome.edges, unmatched: workOutcome.unmatched } } : {}),
  };
}

// ── Journey view: enriched execution walk for the viewer overlay ──────────

/** Parsed graph + index, memoized by graph.json mtime so repeat requests are cheap. */
interface JourneyGraph {
  mtimeMs: number;
  roots: Record<string, string>;
  meta: GraphMeta;
  index: GraphIndex;
  edgesById: Map<string, GraphEdge>;
}
let journeyGraphCache: JourneyGraph | undefined;

/** Load the graph (nodes/edges/roots/meta) memoized by file mtime; throws if the file is gone. */
function loadJourneyGraph(graphPath: string): JourneyGraph {
  const { mtimeMs } = statSync(graphPath);
  if (journeyGraphCache && journeyGraphCache.mtimeMs === mtimeMs) return journeyGraphCache;
  const data = JSON.parse(readFileSync(graphPath, 'utf8'));
  const nodes: GraphNode[] = data.nodes ?? [];
  const edges: GraphEdge[] = data.edges ?? [];
  journeyGraphCache = {
    mtimeMs,
    roots: data.roots ?? {},
    meta: data.meta ?? {},
    index: buildIndex(nodes, edges),
    edgesById: new Map(edges.map((e) => [e.id, e])),
  };
  return journeyGraphCache;
}

/** Node → viewer-facing shape; repo falls back to the id prefix, biz label/description from facets. */
function enrichNode(node: GraphNode) {
  const repo = node.loc?.repo ?? node.id.split('::')[0];
  const biz = node.facets?.business;
  return {
    id: node.id, kind: node.kind, name: node.name, repo,
    ...(node.group ? { group: node.group } : {}),
    tags: node.tags,
    ...(node.docs ? { docs: node.docs } : {}),
    ...(biz?.label ? { bizLabel: biz.label } : {}),
    ...(biz?.description ? { bizDescription: biz.description } : {}),
    ...(node.loc ? { loc: node.loc } : {}),
    ...(node.signature ? { signature: node.signature } : {}),
    // fork points with the category precomputed — the viewer stays heuristic-free
    ...(node.branches?.length ? { branches: node.branches.map((b) => ({ ...b, category: categorizeBranch(b) })) } : {}),
    // routes with a contract link to their API page from journey steps
    ...(node.contract ? { contract: node.contract } : {}),
    // @see URLs / @design as anchors; the design reference for screen cards
    ...(node.links?.length ? { links: node.links } : {}),
    ...(node.design ? { design: node.design } : {}),
  };
}

const CODE_CAP = 160; // max lines sliced per step
const VIA_CAP = 24;   // accessor-borne test refs kept per table step; the total rides beside them

/** Slice loc.line..endLine (1-based inclusive) from disk, fail-soft + path-confined. Null on any miss. */
function sliceFromDisk(
  root: string | undefined,
  loc: NonNullable<GraphNode['loc']>,
  fileCache: Map<string, string[]>,
): { code: string; codeTruncated: boolean } | null {
  if (!root || typeof loc.endLine !== 'number') return null;
  const abs = resolve(join(root, loc.path));
  const rootAbs = resolve(root);
  // path safety: the resolved file must stay inside the repo root
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
  try {
    let lines = fileCache.get(abs);
    if (!lines) { lines = readFileSync(abs, 'utf8').split('\n'); fileCache.set(abs, lines); }
    let slice = lines.slice(loc.line - 1, loc.endLine);
    let codeTruncated = false;
    if (slice.length > CODE_CAP) { slice = slice.slice(0, CODE_CAP); codeTruncated = true; }
    return { code: slice.join('\n'), codeTruncated };
  } catch {
    return null;
  }
}

/** JourneyStep → response step: pass-through fields + enriched node + best-effort code. Never throws. */
function enrichStep(step: JourneyStep, g: JourneyGraph, fileCache: Map<string, string[]>) {
  const node = g.index.byId.get(step.nodeId)!;
  if (step.planned) {
    // a planned call is the REAL route the design names (card + contract link); the other kinds are a
    // contract's intent, not a node: the viewer draws them dashed under the declared route they belong to
    if (step.planned.kind === 'calls') return { ...step, node: enrichNode(node) };
    const repo = node.loc?.repo ?? node.id.split('::')[0];
    return { ...step, node: { id: `${node.id}#planned:${step.order}`, kind: 'planned', name: step.planned.label, repo, tags: [], routeId: node.id, ...(node.contract ? { contract: node.contract } : {}) } };
  }
  const out: Record<string, unknown> = { ...step, node: enrichNode(node) };
  // what verifies this step (docs/proposals/tests-surface.md §3.4): unit/e2e counts +
  // the tests themselves, so the band draws its foot and gutter with no second request
  const coverage = stepCoverage(g.index, step.nodeId);
  if (coverage && coverage.tests.length) out.coverage = coverage;
  else if (node.kind === 'table') {
    // nothing tests a table directly, so an empty foot here reads as untested.
    // What reaches its accessors is the evidence it has: named, capped, and
    // carrying its own total so the cap is visible rather than silent (B4.2).
    const via = verifiedThrough(g.index, step.nodeId);
    if (via.length) { out.coverageVia = via.slice(0, VIA_CAP); out.coverageViaCount = via.length; }
  }

  if (step.via === 'reads' || step.via === 'writes') {
    // data steps carry the query text on their db edge, not a source span
    const edge = step.edgeId ? g.edgesById.get(step.edgeId) : undefined;
    if (typeof edge?.meta?.code === 'string') out.code = edge.meta.code;
    return out;
  }
  // publishes/queue steps have no code; function/component/route/rule steps slice their body
  if (node.loc) {
    const sliced = sliceFromDisk(g.roots[node.loc.repo], node.loc, fileCache);
    if (sliced) {
      out.code = sliced.code;
      out.codeStartLine = node.loc.line;
      if (sliced.codeTruncated) out.codeTruncated = true;
    } else if (node.snippet) {
      // fail-soft: missing root/file/endLine → the stored snippet, gutter still at loc.line
      out.code = node.snippet;
      out.codeStartLine = node.loc.line;
    }
  }
  return out;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif' };
function imageType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return IMAGE_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * A screen's Figma frame as a PNG, fetched once with FIGMA_TOKEN through the
 * images API and cached under .farsight/cache/design/<fileKey>/<node>.png.
 * Re-fetched when the design's lastModified is newer than the cache (or the
 * cache is a day old). No token → null: the deep link is the fallback.
 */
async function designImageFromFigma(ws: string, node: GraphNode): Promise<{ bytes: Buffer; type: string } | null> {
  const token = process.env.FIGMA_TOKEN;
  const key = figmaFileKey(node.design?.url);
  const nodeId = node.design?.nodeId;
  if (!token || !key || !nodeId) return null;
  const dir = join(cacheDir(ws), 'design', key);
  const file = join(dir, `${nodeId}.png`);
  try {
    const st = statSync(file);
    const fresh = node.design?.lastModified ? st.mtimeMs >= Date.parse(node.design.lastModified) : Date.now() - st.mtimeMs < 864e5;
    if (fresh) return { bytes: readFileSync(file), type: 'image/png' };
  } catch { /* not cached */ }
  const res = await fetch(`https://api.figma.com/v1/images/${key}?ids=${encodeURIComponent(nodeId.replace('-', ':'))}&format=png&scale=1`, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Figma images API: HTTP ${res.status}`);
  const body = (await res.json()) as { images?: Record<string, string | null> };
  const src = Object.values(body.images ?? {})[0];
  if (!src) return null;
  const img = await fetch(src, { signal: AbortSignal.timeout(30_000) });
  if (!img.ok) throw new Error(`Figma render download: HTTP ${img.status}`);
  const bytes = Buffer.from(await img.arrayBuffer());
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, bytes);
  return { bytes, type: 'image/png' };
}

// ── design shots: what a screen's design looked like at a sync (chunk H8) ──
//
// change-history-2026-09.md §5, and §9 of the same document draws the line this
// code stays behind. Farsight does **not** screenshot the running app or the HUD:
// no package here ships a browser, and putting one in the install path would
// contradict ADR 6 (tree-sitter as prebuilt WASM, no native deps) and the
// `node:sqlite` choice. What is retained is the image the manifest *already*
// points at — a file in the repository, or a Figma render this server has already
// fetched and cached — copied by content address, so a reader can open the
// picture sync 41 saw instead of being told about it.
//
// Three rules hold the whole feature:
//
// 1. **Nothing is written unless the workspace asked.** `flags.designShots` off
//    means `captureShots` is never called: no directory, no file, no row.
// 2. **The pass reads only what is already on disk.** A Figma render is taken
//    from `.farsight/cache/design/` if it is there, and no request is made if it
//    is not — a sync must not turn into N network calls with N timeouts. A screen
//    whose render has never been fetched simply has no shot for that sync, and
//    says so.
// 3. **Absence is absence.** A sync with no row for a screen means no shot was
//    taken then; `/api/design/image?sync=N` renders that, and never falls back to
//    today's image under a past sync's name.

/** `<digest>.<ext>` under the shots cache — validated at both ends so a name can never escape it. */
const SHOT_DIGEST = /^[0-9a-f]{8,64}$/;
const SHOT_EXT = /^[a-z0-9]{1,5}$/;

function shotsDir(ws: string): string { return join(cacheDir(ws), 'shots'); }

/**
 * Content address of a design image: sha-256, 16 hex characters. Wider than the
 * 12-hex sha-1 identity digests elsewhere in the store on purpose — those name a
 * graph for a reader, this one *is* the filename, and a collision would serve one
 * screen's picture for another's.
 */
function shotDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** A repo-relative design image, resolved and confined to its source's checkout. */
function designFileBytes(root: string | undefined, path: string | undefined): Buffer | null {
  if (!root || !path) return null;
  const base = resolve(root);
  const abs = resolve(join(base, path));
  if (!(abs === base || abs.startsWith(base + sep)) || !existsSync(abs)) return null;
  try { return readFileSync(abs); } catch { return null; }
}

/** A Figma render this server has already cached — read only, no request during a sync. */
function figmaCacheBytes(ws: string, node: GraphNode): { bytes: Buffer; source: string } | null {
  const key = figmaFileKey(node.design?.url);
  const nodeId = node.design?.nodeId;
  if (!key || !nodeId) return null;
  const file = join(cacheDir(ws), 'design', key, `${nodeId}.png`);
  try { return { bytes: readFileSync(file), source: `.farsight/cache/design/${key}/${nodeId}.png` }; } catch { return null; }
}

/** What a shot pass did — reported by `/api/sync` so a reader is never left guessing whether it ran. */
export interface ShotOutcome {
  /** screens carrying a design image at all */
  screens: number;
  /** shots recorded for this sync */
  captured: number;
  /** distinct content addresses among them — how many files the cache now holds for this sync */
  files: number;
  /** bytes this pass added to the cache; 0 when every image was already stored under its digest */
  written: number;
  /** screens with an image the pass could not read, with the reason — an absence, named */
  skipped: { node: string; reason: 'file-not-reachable' | 'figma-not-cached' }[];
}

/**
 * Retain every screen's design image for one sync. Deduplicated by content
 * address: a file already under `.farsight/cache/shots/` is not rewritten, so
 * twenty syncs of an unchanged screen cost one file and twenty ~70-byte rows.
 *
 * Bounded by the number of screens a manifest declares, and by local file reads
 * only — see rule 2 above. Fail-soft throughout: a shot pass must never be the
 * reason a sync fails, so a screen that cannot be read is counted and named.
 */
function captureShots(ws: string, db: SnapshotDb, sync: number, store: GraphStore): ShotOutcome {
  const out: ShotOutcome = { screens: 0, captured: 0, files: 0, written: 0, skipped: [] };
  const shots: ShotInput[] = [];
  const dir = shotsDir(ws);
  for (const node of store.allNodes()) {
    const img = node.design?.image;
    if (!img) continue;
    out.screens += 1;
    const repo = node.loc?.repo ?? node.id.split('::')[0]!;
    let bytes: Buffer | null = null;
    let source = '';
    let ext = 'png';
    if (img.kind === 'file') {
      bytes = designFileBytes(store.roots[repo], img.path);
      if (!bytes) { out.skipped.push({ node: node.id, reason: 'file-not-reachable' }); continue; }
      source = img.path!;
      const dot = source.lastIndexOf('.');
      ext = dot > 0 ? source.slice(dot + 1).toLowerCase() : '';
    } else {
      const got = figmaCacheBytes(ws, node);
      if (!got) { out.skipped.push({ node: node.id, reason: 'figma-not-cached' }); continue; }
      bytes = got.bytes;
      source = got.source;
    }
    if (!SHOT_EXT.test(ext) || !IMAGE_TYPES['.' + ext]) { out.skipped.push({ node: node.id, reason: 'file-not-reachable' }); continue; }
    const digest = shotDigest(bytes);
    const file = join(dir, `${digest}.${ext}`);
    if (!existsSync(file)) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, bytes);
        out.written += bytes.length;
      } catch { out.skipped.push({ node: node.id, reason: 'file-not-reachable' }); continue; }
    }
    shots.push({ node: node.id, repo, digest, ext, kind: img.kind, source, bytes: bytes.length });
  }
  if (shots.length) db.writeShots(sync, shots);
  out.captured = shots.length;
  out.files = new Set(shots.map((sh) => sh.digest)).size;
  return out;
}

/**
 * The bytes of one retained shot. The name is rebuilt from the row's own digest
 * and extension and re-confined to the shots cache — a `?sync=` parameter must
 * widen nothing about what this server will read off disk, and the two regexes
 * mean even a hand-edited database row cannot name a path outside it.
 */
function shotBytes(ws: string, row: ShotRow): { bytes: Buffer; type: string } | null {
  if (!SHOT_DIGEST.test(row.digest) || !SHOT_EXT.test(row.ext)) return null;
  const base = resolve(shotsDir(ws));
  const abs = resolve(join(base, `${row.digest}.${row.ext}`));
  if (!abs.startsWith(base + sep) || !existsSync(abs)) return null;
  try { return { bytes: readFileSync(abs), type: imageType(abs) }; } catch { return null; }
}

// ── Change history: the spine, the diff, and the frozen permalink (chunk H5) ─
//
// docs/proposals/change-history-2026-09.md §7. Three read-only endpoints over
// the history tables H1–H4 built. Every number and every sentence comes from the
// same core fold `farsight history` and `farsight diff --attribute` print, so a
// reader cannot meet one fact worded two ways. Nothing here runs `git log`:
// walking a history is `farsight history`'s job by design (§8), so that a slow
// history can never slow a request — these endpoints read the tables and, for
// the repository's present state only, two O(1) `git rev-parse` probes.

/** The workspace's snapshot store. Throws SnapshotUnavailable where node:sqlite is missing. */
function openHistory(ws: string): SnapshotDb {
  return new SnapshotDb(join(ws, '.farsight', 'farsight.db'));
}

/** Every repository this workspace could have a history for — named in a 400 rather than guessed at. */
function knownRepos(ws: string, graphPath: string): string[] {
  const names = new Set<string>();
  try {
    if (existsSync(graphPath)) for (const r of Object.keys(loadJourneyGraph(graphPath).roots)) names.add(r);
  } catch { /* an unreadable graph is not a reason to refuse the list */ }
  for (const src of loadSettings(ws).sources) if (src.type === 'local' && src.enabled !== false) names.add(src.name || src.id);
  return [...names].sort();
}

/**
 * Where a source's code is — the graph's recorded root first (that is the
 * checkout ingest actually read), then the workspace source's path. Snapshots
 * carry no `roots` by design (snapshots.ts), so history can never supply one.
 */
function checkoutRoot(ws: string, graphPath: string, repo: string): string | undefined {
  try {
    if (existsSync(graphPath)) {
      const root = loadJourneyGraph(graphPath).roots[repo];
      if (root && existsSync(root)) return root;
    }
  } catch { /* fall through to the workspace source */ }
  const src = loadSettings(ws).sources.find((x) => x.type === 'local' && (x.name === repo || x.id === repo));
  if (!src) return undefined;
  const abs = resolve(ws, src.path);
  return existsSync(abs) ? abs : undefined;
}

/** `git rev-parse --show-prefix` at a source's checkout — the monorepo join attribution needs (§8). */
function attributionCheckout(ws: string, graphPath: string, repo: string): CheckoutFact {
  const root = checkoutRoot(ws, graphPath, repo);
  if (!root) return { kind: 'missing' };
  const p = gitPrefix(root);
  return p.available ? { kind: 'prefix', prefix: p.prefix } : { kind: 'unreadable', root, reason: GIT_ABSENT_WORD[p.reason] };
}

/** "sync:41" | "41" | "latest" → a sync number, or null when it is neither. */
function resolveSync(db: SnapshotDb, value: string): number | null {
  const ref = parseSyncRef(value);
  if (ref === null) return null;
  if (ref !== 'latest') return ref;
  return db.list(1)[0]?.sync ?? null;
}

/** The oldest commit this repository's recorded history holds — the floor a shallow clone reports. */
function oldestKnownCommit(spine: CommitSpine): string | undefined {
  let oldest: { sha: string; at: string } | undefined;
  const consider = (c: { sha: string; at: string }) => { if (!oldest || c.at < oldest.at) oldest = c; };
  for (const c of spine.before) consider(c);
  for (const c of spine.after) consider(c);
  for (const row of spine.rows) for (const c of row.commits) consider(c);
  return oldest?.sha;
}

/**
 * A spine row on the wire. `swept` and `unindexed` are **null, not 0**, whenever
 * the sync's commit is one this history cannot place — whether because the
 * history does not contain it or because no history has been read at all: it
 * swept an unknown number of commits, and zero would be a number the data does
 * not carry. `commitState` says which of those it is, and `note` is the shared
 * fold, so the column the CLI prints and the field the HUD reads are the same
 * sentence.
 */
function historyRowOut(row: SpineRow) {
  const note = spineRowNote(row);
  return {
    sync: row.sync,
    at: row.at,
    ...(row.commit ? { commit: row.commit } : {}),
    ...(row.commitFrom ? { commitFrom: row.commitFrom } : {}),
    // true/false = this sync did / did not walk this source; absent = the sync
    // recorded no source rows at all, so the question has no answer here (H3b)
    ...(row.inSync === undefined ? {} : { inSync: row.inSync }),
    // the workspace root's sha, neither folded as this repository's commit nor ruled
    // out, because no history has been read to check it against
    ...(row.commitUnverified ? { commitUnverified: row.commitUnverified } : {}),
    // one word for what is known about this row's commit — the field to switch on:
    // recorded · not-in-history · below-floor · history-unread · none · not-in-sync
    commitState: row.commitState,
    // true / false / null — null means the question could not be asked at all
    commitKnown: row.commitKnown,
    reindexed: row.reindexed,
    // same commit, files differ: the working tree differed from HEAD at this sync
    ...(row.treeChanged ? { treeChanged: true } : {}),
    // strictly `true` earns a number: an unaskable row has no count, and 0 would be one
    swept: row.commitKnown === true ? row.commits.length : null,
    unindexed: row.commitKnown === true ? row.unindexed : null,
    note: note.kind,
    noteText: note.text,
    commits: row.commits.map((c) => c.sha),
  };
}

/**
 * What a set of commits did to **files** — the only granularity these rows have
 * (§2), folded once here so `/api/history` and the Changes surface cannot
 * disagree about it.
 *
 * It exists for §6's second question: *why did that sync report hundreds of
 * removals when nothing was deleted?* Node ids embed the path, so a file git
 * matched as moved leaves the diff as a removal plus an addition — `renamed`
 * is how many of the range's file rows git paired across a move, and
 * `identical` how many of those it scored byte-for-byte the same (R100).
 *
 * A **copy** is deliberately not counted as a rename: it adds a path without
 * removing one, so it explains no removal.
 */
function fileFacts(db: SnapshotDb, repo: string, shas: readonly string[]): { touched: number; renamed: number; identical: number } {
  if (!shas.length) return { touched: 0, renamed: 0, identical: 0 };
  const { files } = db.historyRows(repo, { shas });
  const paths = new Set<string>();
  let renamed = 0;
  let identical = 0;
  for (const f of files) {
    paths.add(f.path);
    if (f.status !== 'renamed') continue;
    renamed += 1;
    if (f.similarity === 100) identical += 1;
  }
  return { touched: paths.size, renamed, identical };
}

/**
 * `?flow=` resolves the way `/api/journey` resolves `?entry=`: the **id** first,
 * then the design id, then the exact name — one class at a time, never a fuzzy
 * search, and the answer says which class matched (`resolvedFrom`). Two flows can
 * share a name across sources; the id can only ever mean one row, so a caller that
 * holds an id gets that row and nothing else.
 *
 * Nothing matched → no rows and no `resolvedFrom`: a filter that matched nothing is
 * a fact, not an error, and the missing key is how a reader tells "did not resolve"
 * from "resolved to a row".
 */
function resolveFlowRows<T extends { flowId: string; designId?: string; name: string }>(
  rows: T[], flow: string,
): { rows: T[]; resolvedFrom?: 'id' | 'designId' | 'name' } {
  const byId = rows.filter((r) => r.flowId === flow);
  if (byId.length) return { rows: byId, resolvedFrom: 'id' };
  const byDesign = rows.filter((r) => r.designId === flow);
  if (byDesign.length) return { rows: byDesign, resolvedFrom: 'designId' };
  const byName = rows.filter((r) => r.name === flow);
  if (byName.length) return { rows: byName, resolvedFrom: 'name' };
  return { rows: [] };
}

/**
 * The report ledger and the structured gaps the tests post-pass recorded, stamped
 * with the repo they came from — the evidence behind every number on the Tests tab
 * (board 08: what matched, what ran, whether a digest still holds).
 *
 * Scope here is the **requested** scope, not the repos that happen to have test
 * nodes: a glob that matched no file produces no tests at all, and that is exactly
 * the row a reader needs to see. (`blindSpots` in the fold is derived from the repos
 * of the tests in scope, so it cannot say this.)
 *
 * Absence is kept apart from emptiness: the key is missing when no repo in scope
 * recorded that array — a graph written before the tests post-pass — and `[]` when
 * the pass ran and named nothing.
 */
function testsEvidence(meta: Record<string, TestsMeta> | undefined, scope: Set<string> | null): {
  reports?: (TestsMeta['reports'][number] & { repo: string })[];
  gaps?: (NonNullable<TestsMeta['gaps']>[number] & { repo: string })[];
} {
  if (!meta) return {};
  const repos = Object.keys(meta).filter((r) => !scope || scope.has(r)).sort();
  let anyReports = false;
  let anyGaps = false;
  const reports: (TestsMeta['reports'][number] & { repo: string })[] = [];
  const gaps: (NonNullable<TestsMeta['gaps']>[number] & { repo: string })[] = [];
  for (const repo of repos) {
    const tm = meta[repo]!;
    if (tm.reports) { anyReports = true; for (const r of tm.reports) reports.push({ repo, ...r }); }
    if (tm.gaps) { anyGaps = true; for (const gp of tm.gaps) gaps.push({ repo, ...gp }); }
  }
  return { ...(anyReports ? { reports } : {}), ...(anyGaps ? { gaps } : {}) };
}

export function serveGraph(graphPath: string, port: number, workspaceDir = process.cwd()): void {
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const ws = resolve(workspaceDir);

  // one-time size-based retention of the Model Hub event stream
  rotateEventsFile();

  /** per-source Storybook URL overrides from the workspace settings, keyed by source name (= repo) */
  const storybookOverrides = (): Record<string, { url?: string; command?: string }> => {
    const out: Record<string, { url?: string; command?: string }> = {};
    for (const src of loadSettings(ws).sources ?? []) if (src.storybook?.url && isStorybookUrl(src.storybook.url)) out[src.name] = src.storybook;
    return out;
  };
  /** the origins the viewer may frame: every Storybook URL the graph recorded, after overrides */
  const storybookOrigins = (): string[] => {
    if (!existsSync(graphPath)) return [];
    const origins = new Set<string>();
    try {
      for (const { ref } of storybooksOf(loadJourneyGraph(graphPath).meta.stories, storybookOverrides())) {
        if (!isStorybookUrl(ref.url)) continue;
        origins.add(new URL(ref.url).origin);
      }
    } catch { /* an unreadable graph frames nothing */ }
    return [...origins].sort();
  };

  const server = createServer((req, res) => {
    const send = (code: number, body: string | Buffer, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };
    const url = req.url ?? '/';
    // loopback names only (DNS rebinding), and no state change from another site (CSRF) — guard.ts
    const refused = refuseRequest(req);
    if (refused) return send(403, JSON.stringify({ error: refused }));

    if (url === '/' || url === '/index.html') {
      // frames: only this server and the Storybooks the graph (or a source's settings) recorded —
      // the viewer never frames an origin nobody configured or discovered (ADR 9)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `object-src 'none'; base-uri 'self'; frame-src 'self' ${storybookOrigins().join(' ')}`.trim() });
      return res.end(readFileSync(join(publicDir, 'viewer.html')));
    }
    if (url.startsWith('/compare/') && req.method === 'GET') {
      // §9: `farsight-diff v1` froze `permalink` as /compare/<base>...<head>#<id>
      // while the viewer routes #/changes/<base>...<head> and nothing served
      // /compare — so every permalink minted since July was a 404. The freeze
      // forbids changing the field, so the server honours it instead.
      //
      // The change id cannot survive this hop: a fragment is never sent to a
      // server (RFC 3986 §3.5), and a Location that carries its own fragment
      // replaces whatever the client held (RFC 9110 §10.2.2). So the range
      // arrives and the id does not — stated here rather than pretended away.
      // A client that percent-encoded the fragment into the path is accepted
      // too; the range is still all that can be carried across.
      const path = decodeURIComponent(url.split('?')[0]!.split('#')[0]!);
      const m = path.match(/^\/compare\/(\d+)\.\.\.(\d+)(?:#.*)?$/);
      if (!m) return send(404, JSON.stringify({ error: `not a comparison link: expected /compare/<baseSync>...<headSync> as farsight-diff v1 mints it (got ${url})` }));
      res.writeHead(302, { location: `/#/changes/${m[1]}...${m[2]}` });
      return res.end();
    }
    if (url === '/grammar') {
      // the Grammar Book fixture page is a viewer route; keep a stable server path for it
      res.writeHead(302, { location: '/#/grammar' });
      return res.end();
    }
    if (url.startsWith('/app/') && req.method === 'GET') {
      // viewer ES modules — path-confined static handler (same discipline as sliceFromDisk)
      const rel = url.split('?')[0]!;
      const abs = resolve(join(publicDir, rel));
      const appRoot = resolve(join(publicDir, 'app'));
      if ((abs === appRoot || abs.startsWith(appRoot + sep)) && abs.endsWith('.js') && existsSync(abs)) {
        return send(200, readFileSync(abs), 'text/javascript; charset=utf-8');
      }
      return send(404, JSON.stringify({ error: 'not found' }));
    }
    if (url === '/api/strings' && req.method === 'GET') {
      // the two-register string catalog (core/strings.ts) — the viewer's only source of chrome text
      return send(200, JSON.stringify({ registers: ['hud', 'professional'], strings: STRINGS }));
    }
    if (url === '/graph') {
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      return send(200, readFileSync(graphPath));
    }
    if (url === '/api/version' && req.method === 'GET') {
      // which Farsight is serving (version · built · commit) and which one wrote the graph — a consumer's "when was this last updated"
      const m = existsSync(graphPath) ? loadJourneyGraph(graphPath).meta : {};
      // plus: is a newer build installed than this process runs, and does the graph match — with the steps to fix either
      const install = installState();
      const currency = currencyAdvice({ role: 'server', running: buildInfo(), install, graph: { farsight: m.farsight, generatedAt: m.generatedAt, sync: m.sync } });
      return send(200, JSON.stringify({ farsight: buildInfo(), install, currency, graph: { generatedAt: m.generatedAt, sync: m.sync, workspace: m.workspace, graphPath: m.graphPath, farsight: m.farsight } }));
    }
    if ((url === '/api/stories' || url.startsWith('/api/stories?')) && req.method === 'GET') {
      // the Storybooks the graph recorded, whether each answered, how its index mapped onto
      // nodes, and every component's stories with graph and live merged (core storybookLive).
      // Read only: this server never starts a Storybook. ?node= narrows to one node,
      // ?refresh=1 re-reads the index instead of the few-second cache.
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const q = new URL(url, 'http://localhost').searchParams;
      const g = loadJourneyGraph(graphPath);
      const scopeParam = q.get('scope');
      const repos = scopeParam && scopeParam !== 'all' ? new Set(scopeParam.split(',').map((x) => x.trim()).filter(Boolean)) : null;
      const nodeId = q.get('node');
      storybookLive([...g.index.byId.values()], g.meta.stories, { overrides: storybookOverrides(), fresh: q.get('refresh') === '1', repos })
        .then((answer) => {
          if (nodeId) {
            const node = g.index.byId.get(nodeId);
            if (!node) return send(404, JSON.stringify({ error: `nothing in the graph matches: ${nodeId}` }));
            const repo = node.loc?.repo ?? nodeId.split('::')[0];
            // the block's three numbers, named apart: this node's own stories, its docs
            // pages (tabs, never stories), and the stories of the parts it renders
            const { partIds, ...counts } = storyCounts(g.index, nodeId, answer.byNode);
            return send(200, JSON.stringify({ node: nodeId, stories: answer.byNode[nodeId] ?? [], storybooks: answer.storybooks.filter((b) => b.repo === repo), counts, parts: partIds }));
          }
          return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, ...answer }));
        })
        .catch((err) => send(500, JSON.stringify({ error: String((err as Error)?.message ?? err) })));
      return;
    }
    if (url.startsWith('/api/journey') && req.method === 'GET') {
      // linearized execution walk from one entry node, enriched with on-disk code
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const q = new URL(url, 'http://localhost').searchParams;
      const entryArg = q.get('entry');
      if (!entryArg) return send(400, JSON.stringify({ error: 'missing ?entry=<node id or name>' }));
      const g = loadJourneyGraph(graphPath);
      // a name resolves the way the MCP `journey` tool resolves it; the payload carries the id it landed on
      const entryNode = resolveEntry(g.index, entryArg, { ...(q.get('repo') ? { repo: q.get('repo')! } : {}), ...(q.get('group') ? { group: q.get('group')! } : {}) });
      if (!entryNode) return send(404, JSON.stringify({ error: `nothing in the graph matches: ${entryArg}` }));
      const entry = entryNode.id;
      const depth = Number(q.get('depth'));
      const jr = journey(g.index, entry, Number.isFinite(depth) && depth > 0 ? { maxDepth: depth } : {});
      const fileCache = new Map<string, string[]>(); // per-request only; never held in the module cache
      const screens = screensFor(g.index, entry);
      return send(200, JSON.stringify({
        entry: enrichNode(entryNode),
        ...(entry !== entryArg ? { resolvedFrom: entryArg } : {}),
        generatedAt: g.meta.generatedAt,
        truncated: jr.truncated,
        forkCount: jr.forkCount,
        plannedCount: jr.plannedCount,
        // subtrees the walk did not follow — local, so the HUD draws "n cut points", not "truncated"
        cutPoints: jr.cutPoints,
        // the SCREEN band: the entry when it is a screen, else the pages/components upstream — derived, with their design refs
        screens: screens.map(enrichNode),
        // the three-band blueprint (what the user sees · business · what the system does) — same fold the MCP prints
        summary: journeySummary(g.index, jr, screens),
        steps: jr.steps.map((s) => enrichStep(s, g, fileCache)),
        edges: jr.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
      }));
    }
    // ── Tests surface (docs/proposals/tests-surface.md §3.4) ─────────────
    if (url.startsWith('/api/tests') && req.method === 'GET') {
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const u = new URL(url, 'http://localhost');
      const g = loadJourneyGraph(graphPath);
      const rest = u.pathname.slice('/api/tests'.length).replace(/^\//, '');
      const scopeParam = u.searchParams.get('scope');
      const scope = scopeParam && scopeParam !== 'all' ? new Set(scopeParam.split(',').map((x) => x.trim()).filter(Boolean)) : null;
      // `matrix` is a reserved path segment, not a test id (ids are `repo::path::name`)
      if (rest === 'matrix') {
        // the `farsight-tests-matrix v1` document — the same fold, the same identity and
        // the same bytes `farsight tests matrix` prints (docs/contracts/farsight-tests-matrix-v1.md)
        const format = u.searchParams.get('format') ?? 'json';
        if (format !== 'json' && format !== 'csv') return send(400, JSON.stringify({ error: `unknown ?format=${format} — json or csv` }));
        const doc = testsMatrixV1(g.index, testsSurface(g.index, scope, g.meta.tests), testsIdentity(g.meta));
        if (format === 'csv') return send(200, testsMatrixCsv(doc.rows), 'text/csv; charset=utf-8');
        return send(200, JSON.stringify(doc));
      }
      if (rest) {
        const detail = testDetail(g.index, decodeURIComponent(rest));
        if (!detail) return send(404, JSON.stringify({ error: `no test with id ${decodeURIComponent(rest)}` }));
        // the same identity the catalogue carries: every claim on one test's
        // page is as of a named sync, commit and content digest (03 §4.2)
        return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, identity: testsIdentity(g.meta), ...detail }));
      }
      const level = u.searchParams.get('level');
      const flow = u.searchParams.get('flow');
      const nodeId = u.searchParams.get('node');
      // ?node= answers "what verifies this one thing" without walking the catalogue
      if (nodeId) {
        const node = g.index.byId.get(nodeId);
        if (!node) return send(404, JSON.stringify({ error: `nothing in the graph matches: ${nodeId}` }));
        return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, node: enrichNode(node), coverage: stepCoverage(g.index, nodeId) }));
      }
      // the level filter reaches the counts and tiles as well as the rows: under ?level=e2e
      // the header used to print every level's cases above e2e rows (pass swarm 2026-09-25)
      const lv = level === 'unit' || level === 'integration' || level === 'e2e' ? level : undefined;
      const surface = testsSurface(g.index, scope, g.meta.tests, { level: lv });
      const resolved = flow ? resolveFlowRows(surface.journeys, flow) : undefined;
      const filtered = {
        ...surface,
        sources: level ? surface.sources.filter((c) => c.level === level) : surface.sources,
        suites: level ? surface.suites.filter((r) => r.level === level) : surface.suites,
        journeys: resolved ? resolved.rows : surface.journeys,
      };
      // ?flow= also answers the flow's own coverage directly, so a caller need not scan the matrix
      const flowRow = resolved?.rows[0];
      return send(200, JSON.stringify({
        generatedAt: g.meta.generatedAt, scope: scopeParam ?? 'all',
        // which build and which graph these numbers came from — the matrix's identity block, so
        // a screen and a CI artefact quote the same sync, commit and content digest
        identity: testsIdentity(g.meta),
        ...(level ? { level } : {}), ...(flow ? { flow } : {}),
        ...(resolved?.resolvedFrom ? { resolvedFrom: resolved.resolvedFrom } : {}),
        ...filtered,
        // the evidence behind the counts: every configured report with its glob and reason,
        // and the gaps as data — absent when the graph recorded none, `[]` when it recorded nothing
        ...testsEvidence(g.meta.tests, scope),
        ...(flowRow ? { coverage: flowRow.coverage } : {}),
      }));
    }
    // ── Design surface (docs/proposals/design-source.md) ─────────────────
    if (url === '/api/design/guide' && req.method === 'GET') {
      // the recipe for a design-backed journey — the same text the MCP design_guide tool returns
      return send(200, designGuide(), 'text/markdown; charset=utf-8');
    }
    if (url.startsWith('/api/design/image') && req.method === 'GET') {
      // the image behind a screen's design reference: a repo-relative file (path-confined) or a Figma render cached on disk
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const u = new URL(url, 'http://localhost');
      const nodeId = u.searchParams.get('node');
      const g = loadJourneyGraph(graphPath);
      const node = nodeId ? g.index.byId.get(nodeId) : undefined;
      const img = node?.design?.image;
      if (!node || !img) return send(404, JSON.stringify({ error: 'no design image for this node' }));
      // ?sync=N — the image this screen had at that sync, from the shots cache (chunk H8).
      // A separate branch on purpose: it must never fall through to the live image, because
      // a reader asking what a screen looked like at sync 41 has to be told when nothing was
      // kept rather than shown today's picture under sync 41's name.
      const syncParam = u.searchParams.get('sync');
      if (syncParam !== null) {
        const want = /^(?:sync:)?(\d+)$/.exec(syncParam.trim());
        if (!want) return send(400, JSON.stringify({ error: 'sync must be a sync number, e.g. sync=41' }));
        const at = Number(want[1]);
        let row: ShotRow | undefined;
        let db: SnapshotDb | undefined;
        try {
          db = new SnapshotDb(join(ws, '.farsight', 'farsight.db'));
          row = db.shotAt(node.id, at);
        } catch (err) {
          return send(404, JSON.stringify({ error: `no snapshot history in this workspace: ${(err as Error).message.split('\n')[0]}`, sync: at, absent: true }));
        } finally { db?.close(); }
        if (!row) {
          return send(404, JSON.stringify({
            // the six absence words' posture: say what is missing, never substitute for it
            error: `no design shot was kept for this screen at sync ${at} — the image on disk today is not what that sync saw, so it is not served here`,
            sync: at, absent: true, node: node.id,
          }));
        }
        const got = shotBytes(ws, row);
        if (!got) {
          return send(404, JSON.stringify({
            error: `sync ${at} recorded a design shot (${row.digest}) whose file is no longer in .farsight/cache/shots`,
            sync: at, absent: true, digest: row.digest,
          }));
        }
        // which picture this is, so a caller holding the bytes can still say where they came
        // from. ASCII only and quoted: a header value is latin-1 on the wire, so the HUD's
        // middle dot would reach a reader as mojibake.
        res.setHeader('X-Farsight-Shot', `${row.digest}; source="${row.source.replace(/[^\x20-\x7e"]/g, '?')}"`);
        return send(200, got.bytes, got.type);
      }
      const repo = node.loc?.repo ?? node.id.split('::')[0]!;
      if (img.kind === 'file') {
        const root = g.roots[repo];
        const abs = root && img.path ? resolve(join(root, img.path)) : '';
        if (!root || !(abs === resolve(root) || abs.startsWith(resolve(root) + sep)) || !existsSync(abs)) return send(404, JSON.stringify({ error: 'design image not reachable from this workspace' }));
        return send(200, readFileSync(abs), imageType(abs));
      }
      designImageFromFigma(ws, node).then((r) => (r ? send(200, r.bytes, r.type) : send(404, JSON.stringify({ error: 'no Figma render: set FIGMA_TOKEN (the deep link still works)' })))).catch((err) => send(502, JSON.stringify({ error: (err as Error).message })));
      return;
    }
    if (url.startsWith('/api/design') && req.method === 'GET') {
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const u = new URL(url, 'http://localhost');
      const g = loadJourneyGraph(graphPath);
      const scopeParam = u.searchParams.get('scope');
      const scope = scopeParam && scopeParam !== 'all' ? new Set(scopeParam.split(',').map((x) => x.trim()).filter(Boolean)) : null;
      const rest = u.pathname.slice('/api/design'.length).replace(/^\//, '');
      if (!rest) return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, scope: scopeParam ?? 'all', figmaToken: !!process.env.FIGMA_TOKEN, designs: designSurface(g.index, scope) }));
      const designId = decodeURIComponent(rest);
      const surface = designSurface(g.index, null).find((d) => d.id === designId);
      if (!surface) return send(404, JSON.stringify({ error: `no design source with id ${designId}` }));
      const screens = surface.screens.map((row) => ({ ...row, node: enrichNode(g.index.byId.get(row.nodeId)!) }));
      return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, figmaToken: !!process.env.FIGMA_TOKEN, ...surface, screens }));
    }
    if (url === '/api/design/diff' && req.method === 'POST') {
      // a proposed manifest against the code — same reconcileDesign() as ingest, nothing persisted (READ-ONLY)
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
          const input = JSON.parse(body || '{}') as { manifest?: string; url?: string; path?: string; repo?: string; format?: string };
          const g = loadJourneyGraph(graphPath);
          let manifest; let label: string; let fresh: { lastModified?: string; freshness?: 'figma' | 'manifest' } = {};
          if (input.url) {
            if (!isManifestUrl(input.url)) return send(400, JSON.stringify({ error: 'url must be http(s)' }));
            const p = await readManifestSource(input.url); manifest = p.manifest; label = input.url; fresh = { ...(p.lastModified ? { lastModified: p.lastModified, freshness: p.freshness } : {}) };
          } else if (input.path) {
            const abs = resolve(join(ws, input.path));
            if (!(abs === ws || abs.startsWith(ws + sep)) || !existsSync(abs)) return send(400, JSON.stringify({ error: 'path must be inside the workspace' }));
            const p = await readManifestSource(input.path, ws); manifest = p.manifest; label = input.path; fresh = { ...(p.lastModified ? { lastModified: p.lastModified, freshness: p.freshness } : {}) };
          } else if (typeof input.manifest === 'string' && input.manifest.trim()) {
            manifest = parseManifestText(input.manifest, 'pasted manifest'); label = 'proposed manifest';
          } else {
            return send(400, JSON.stringify({ error: 'give one of manifest (text), url, or path' }));
          }
          const repo = input.repo ?? 'proposed';
          const result = reconcileDesign(manifest, g.index, { repo, path: label, ...fresh }, { repo, designId: `${repo}::design::${label}` });
          if (input.format === 'md') return send(200, designDriftMarkdown(result), 'text/markdown; charset=utf-8');
          send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, ...result }));
        } catch (err) {
          send(400, JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }
    // ── APIs surface (docs/proposals/openapi-surface.md) ─────────────────
    if (url.startsWith('/api/apis') && req.method === 'GET') {
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const u = new URL(url, 'http://localhost');
      const g = loadJourneyGraph(graphPath);
      const scopeParam = u.searchParams.get('scope');
      const scope = scopeParam && scopeParam !== 'all' ? new Set(scopeParam.split(',').map((x) => x.trim()).filter(Boolean)) : null;
      const rest = u.pathname.slice('/api/apis'.length).replace(/^\//, '');
      if (!rest) return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, scope: scopeParam ?? 'all', apis: apiSurface(g.index, scope) }));
      const wantSpec = rest.endsWith('/spec');
      const apiId = decodeURIComponent(wantSpec ? rest.slice(0, -'/spec'.length) : rest);
      const surface = apiSurface(g.index, null).find((a) => a.id === apiId);
      if (!surface) return send(404, JSON.stringify({ error: `no API surface with id ${apiId}` }));
      if (wantSpec) {
        // the spec file itself (path-confined under the repo root) — a URL source is re-fetched
        if (!surface.specPath) return send(404, JSON.stringify({ error: 'this surface is implied from code — no spec on file. GET /api/openapi?repo=… generates one.' }));
        if (isSpecUrl(surface.specPath)) {
          readSpecSource(surface.specPath).then((p) => send(200, p.text, 'text/plain; charset=utf-8')).catch((err) => send(502, JSON.stringify({ error: (err as Error).message })));
          return;
        }
        const root = g.roots[surface.repo];
        const abs = root ? resolve(join(root, surface.specPath)) : '';
        if (!root || !(abs === resolve(root) || abs.startsWith(resolve(root) + sep)) || !existsSync(abs)) return send(404, JSON.stringify({ error: 'spec file not reachable from this workspace' }));
        return send(200, readFileSync(abs), 'text/plain; charset=utf-8');
      }
      const operations = surface.operations.map((op) => {
        const node = g.index.byId.get(op.routeId)!;
        return {
          ...op,
          ...(node.contract ? { contract: node.contract } : {}),
          ...(node.docs ? { docs: node.docs } : {}),
          consumers: consumersOf(g.index, op.routeId).map((c) => ({
            caller: enrichNode(c.caller), ...(c.line != null ? { line: c.line } : {}), crossRepo: c.crossRepo,
            ...(c.confidence ? { confidence: c.confidence } : {}), screens: c.screens.map(enrichNode),
          })),
        };
      });
      return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, ...surface, operations }));
    }
    // ── dependencies (docs/proposals/dependencies-and-nx.md §2.1, §2.3) — folds over the package nodes ──
    if ((url === '/api/deps' || url.startsWith('/api/deps?') || url.startsWith('/api/deps/where')) && req.method === 'GET') {
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const u = new URL(url, 'http://localhost');
      const g = loadJourneyGraph(graphPath);
      const repo = u.searchParams.get('repo') || undefined;
      const hopsArg = u.searchParams.get('hops');
      const hops = hopsArg ? Number(hopsArg) : undefined;
      if (hops != null && !(Number.isInteger(hops) && hops >= 1 && hops <= IMPACT_MAX_HOPS)) {
        return send(400, JSON.stringify({ error: `?hops= must be a whole number from 1 to ${IMPACT_MAX_HOPS}` }));
      }
      // a graph written before the dependencies pass carries no package node: say so instead of an empty list that reads as "no dependencies"
      const hasPackages = [...g.index.byId.values()].some((n) => n.kind === 'package');
      const stale = hasPackages ? {} : { note: 'this graph was written by a build that did not read imports as packages — re-sync the sources to see them' };
      if (u.pathname === '/api/deps/where') {
        const ref = u.searchParams.get('package');
        if (!ref) return send(400, JSON.stringify({ error: 'missing ?package=<package node id or name>' }));
        const found = resolvePackage(g.index, ref, repo);
        if (!found.hit) {
          return send(400, JSON.stringify({
            error: found.candidates.length ? `${found.candidates.length} sources import a package named ${ref}; pass its id or ?repo=` : `no package ${ref} in this graph`,
            ...(found.candidates.length ? { candidates: found.candidates } : {}), ...stale,
          }));
        }
        return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, ...importersOf(g.index, found.hit.id, hops != null ? { hops } : {}) }));
      }
      const kind = u.searchParams.get('kind') || undefined;
      if (kind && kind !== 'third-party' && kind !== 'workspace') return send(400, JSON.stringify({ error: `unknown ?kind=${kind} — third-party or workspace` }));
      const scopeParam = u.searchParams.get('scope');
      const scoped = scopeParam && scopeParam !== 'all' ? new Set(scopeParam.split(',').map((x) => x.trim()).filter(Boolean)) : null;
      const list = packagesOf(g.index, {
        ...(repo ? { repo } : {}),
        ...(u.searchParams.get('project') ? { project: u.searchParams.get('project')! } : {}),
        ...(kind ? { scope: kind as 'third-party' | 'workspace' } : {}),
        ...(hops != null ? { hops } : {}),
      });
      const rows = scoped ? list.rows.filter((r) => scoped.has(r.repo)) : list.rows;
      const third = rows.filter((r) => r.scope === 'third-party').length;
      const packages = scoped
        ? counted(rows.length, 'count.unit.packages', 'count.scope.workspace', list.packages.source, { breakdown: [
          { key: 'count.part.packagesThirdParty', n: third }, { key: 'count.part.packagesWorkspace', n: rows.length - third }] })
        : list.packages;
      const builtins = Object.fromEntries(Object.entries(g.meta.packages ?? {})
        .filter(([r]) => (!repo || r === repo) && (!scoped || scoped.has(r)))
        .map(([r, m]) => [r, m]));
      return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, scope: scopeParam ?? 'all', rows, packages, meta: builtins, ...stale }));
    }
    // ── projects (docs/proposals/dependencies-and-nx.md §2.2) — a fold over the graph and meta.projects ──
    if ((url === '/api/projects' || url.startsWith('/api/projects?') || url.startsWith('/api/projects/')) && req.method === 'GET') {
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const u = new URL(url, 'http://localhost');
      const g = loadJourneyGraph(graphPath);
      const repo = u.searchParams.get('repo') || undefined;
      const pg = projectGraph(g.index, g.meta.projects, repo ? { repo } : {});
      const rest = decodeURIComponent(u.pathname.slice('/api/projects'.length).replace(/^\//, ''));
      if (!rest) return send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, ...(repo ? { repo } : {}), ...pg }));
      const hit = findProject(pg, rest, repo);
      if (!hit) return send(404, JSON.stringify({ error: `no project named ${rest}${repo ? ` in ${repo}` : ''}` }));
      if (Array.isArray(hit)) return send(409, JSON.stringify({ error: `${hit.length} sources have a project named ${rest}; pass ?repo=`, repos: hit.map((p) => p.repo) }));
      // the fold above is kept per loaded graph, so the node ids are a lookup, not a walk
      const nodeIds = projectNodeIds(g.index, g.meta.projects, hit.repo, hit.name);
      const closure = appClosure(pg, hit.name, hit.repo)!;
      return send(200, JSON.stringify({
        generatedAt: g.meta.generatedAt,
        project: hit,
        dependencies: pg.dependencies.filter((d) => d.repo === hit.repo && d.from === hit.name),
        dependents: pg.dependencies.filter((d) => d.repo === hit.repo && d.to === hit.name),
        closure: { projects: closure.projects, count: closure.count },
        nodeIds,
        tagDimensions: pg.repos.find((r) => r.repo === hit.repo)?.tagDimensions ?? [],
      }));
    }
    if (url.startsWith('/api/openapi') && req.method === 'GET') {
      // a spec generated from the code — every inference marked x-farsight-inferred
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const u = new URL(url, 'http://localhost');
      const repo = u.searchParams.get('repo');
      if (!repo) return send(400, JSON.stringify({ error: 'missing ?repo=<source name>' }));
      const g = loadJourneyGraph(graphPath);
      const doc = graphToSpec(g.index, { repo, meta: g.meta });
      if (!Object.keys(doc.paths ?? {}).length) return send(404, JSON.stringify({ error: `no implemented routes for repo ${repo}` }));
      if (u.searchParams.get('format') === 'yaml') return send(200, specToYaml(doc), 'application/yaml; charset=utf-8');
      return send(200, JSON.stringify(doc, null, 2));
    }
    if (url === '/api/apis/diff' && req.method === 'POST') {
      // a proposed spec against the code — same reconcile() as ingest, nothing persisted (READ-ONLY)
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
          const input = JSON.parse(body || '{}') as { spec?: string; url?: string; path?: string; repo?: string; format?: string };
          const g = loadJourneyGraph(graphPath);
          let parsed: ReturnType<typeof parseSpecText>;
          let label: string;
          if (input.url) {
            if (!isSpecUrl(input.url)) return send(400, JSON.stringify({ error: 'url must be http(s)' }));
            parsed = await readSpecSource(input.url); label = input.url;
          } else if (input.path) {
            const abs = resolve(join(ws, input.path));
            if (!(abs === ws || abs.startsWith(ws + sep)) || !existsSync(abs)) return send(400, JSON.stringify({ error: 'path must be inside the workspace' }));
            parsed = parseSpecText(readFileSync(abs, 'utf8'), input.path); label = input.path;
          } else if (typeof input.spec === 'string' && input.spec.trim()) {
            parsed = parseSpecText(input.spec, 'pasted spec'); label = 'proposed spec';
          } else {
            return send(400, JSON.stringify({ error: 'give one of spec (text), url, or path' }));
          }
          const apiId = input.repo ? `${input.repo}::api::${label}` : `proposed::api::${label}`;
          const result = reconcile(parsed.doc, g.index, { repo: input.repo ?? 'proposed', path: label, lineOf: parsed.lineOf }, { ...(input.repo ? { repo: input.repo } : {}), apiId });
          if (input.format === 'md') return send(200, driftMarkdown(result), 'text/markdown; charset=utf-8');
          send(200, JSON.stringify({ generatedAt: g.meta.generatedAt, ...result }));
        } catch (err) {
          send(400, JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }
    // ── Dependency impact (docs/proposals/dependency-impact.md §4) ───────
    if (url.startsWith('/api/impact') && req.method === 'GET') {
      // the same fold the CLI prints and the MCP answers with, served whole: per hop,
      // with the cut points, the asides and the bound. There is no total in the payload
      // because the fold carries none — a consumer that wants one has to invent it, and
      // the house rule says it must not.
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      const u = new URL(url, 'http://localhost');
      const g = loadJourneyGraph(graphPath);
      const nodeArg = u.searchParams.get('node');
      if (!nodeArg) return send(400, JSON.stringify({ error: 'missing ?node=<node id or name>' }));
      // an exact id, else the best search hit — the same resolver the CLI and the MCP
      // tool use. `resolveEntry` is deliberately not used: it prefers pages and routes
      // because a journey needs somewhere to start, and "invoices" would resolve to a
      // screen rather than to the table the question was about.
      const seed = g.index.byId.get(nodeArg)
        ?? search(g.index, nodeArg, { limit: 1, ...(u.searchParams.get('repo') ? { repo: u.searchParams.get('repo')! } : {}) })[0];
      if (!seed) return send(404, JSON.stringify({ error: `nothing in the graph matches: ${nodeArg}` }));
      const on = (name: string) => ['1', 'true', 'yes'].includes((u.searchParams.get(name) ?? '').toLowerCase());
      const hopsArg = u.searchParams.get('hops');
      const direction = u.searchParams.get('direction') ?? 'upstream';
      if (direction !== 'upstream' && direction !== 'downstream') {
        return send(400, JSON.stringify({ error: `unknown ?direction=${direction} — upstream or downstream` }));
      }
      try {
        const report = impactOf(g.index, seed.id, {
          ...(hopsArg ? { hops: Number(hopsArg) } : {}),
          direction,
          ...(on('tests') ? { tests: true } : {}),
          // one journey walk per flow (60-81 ms on the reference app's ten): never on unless asked for
          ...(on('flows') ? { flows: true } : {}),
          ...(on('include_setup') ? { includeSetup: true } : {}),
          ...(on('include_deferred') ? { includeDeferred: true } : {}),
          ...(on('expand_shared') ? { expandShared: true } : {}),
          ...(u.searchParams.get('cap') ? { perHopCap: Number(u.searchParams.get('cap')) } : {}),
          asOf: {
            ...(g.meta.sync != null ? { sync: g.meta.sync } : {}),
            ...(g.meta.commit ? { commit: g.meta.commit } : {}),
            farsight: buildLine(),
            // whether the checkout still matches is not knowable here without walking the
            // tree on every request: unknown is left unsaid rather than reported as false
          },
        });
        return send(200, JSON.stringify({
          generatedAt: g.meta.generatedAt,
          ...(seed.id !== nodeArg ? { resolvedFrom: nodeArg } : {}),
          seedNode: enrichNode(seed),
          ...report,
          // the Map's Affected mode: the same answer placed on the journeys, screens and calls (one walk
          // per flow, cached per graph) — additive, asked for by name
          ...(on('reach') ? { reach: affectedReach(g.index, report) } : {}),
        }));
      } catch (err) {
        // a refused budget is a sentence with a 400, not a 500 (§8)
        return send(400, JSON.stringify({ error: (err as Error).message }));
      }
    }
    // ── one commit and the parts it touched (the Map's Affected mode seeds, map-pass-2026-10-03 §4) ──
    if (url.startsWith('/api/history/commit') && req.method === 'GET') {
      const u = new URL(url, 'http://localhost');
      const sha = (u.searchParams.get('sha') ?? '').trim();
      if (!sha) return send(400, JSON.stringify({ error: 'missing ?sha=<commit sha, or its first characters>' }));
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      let db: SnapshotDb;
      try {
        db = openHistory(ws);
      } catch (err) {
        return send(503, JSON.stringify({ error: (err as Error).message }));
      }
      try {
        const want = u.searchParams.get('repo');
        const rows = db.commitsByPrefix(sha).filter((r) => !want || r.repo === want);
        const row = rows[0];
        if (!row) return send(404, JSON.stringify({ error: `no commit read starts with ${sha}` }));
        const g = loadJourneyGraph(graphPath);
        // the parts its hunks were resolved to (`lines`), else every part defined in a file it changed
        // (`file`, the same whole-path suffix rule /api/history/touching credits) — modules only when
        // a file holds nothing else
        const resolved = db.commitNodes(row.repo, row.sha);
        let parts: { node: string; how: 'lines' | 'file' }[] = [];
        if (resolved && resolved.some((r) => !r.fileOnly)) {
          parts = resolved.filter((r) => !r.fileOnly && g.index.byId.has(r.node)).map((r) => ({ node: r.node, how: 'lines' as const }));
        } else {
          const files = db.filesForCommit(row.repo, row.sha).map((f) => f.path);
          const inFile = (n: GraphNode) => !!n.loc?.path && (n.loc.repo ?? n.id.split('::')[0]) === row.repo
            && files.some((f) => f === n.loc!.path || f.endsWith('/' + n.loc!.path));
          const hit = [...g.index.byId.values()].filter(inFile);
          const own = hit.filter((n) => n.kind !== 'module' && n.kind !== 'test');
          parts = (own.length ? own : hit.filter((n) => n.kind !== 'test')).map((n) => ({ node: n.id, how: 'file' as const }));
        }
        return send(200, JSON.stringify({ ...row, parts, ...(rows.length > 1 ? { ambiguous: rows.length } : {}) }));
      } finally {
        db.close();
      }
    }
    // ── the commits that touched a set of parts (the Map's Changes tab, map-pass-2026-10-03 §3 N) ──
    if (url.startsWith('/api/history/touching') && req.method === 'GET') {
      const u = new URL(url, 'http://localhost');
      const repo = u.searchParams.get('repo');
      const ids = (u.searchParams.get('nodes') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!repo || !ids.length) return send(400, JSON.stringify({ error: 'missing ?repo=<source name>&nodes=<node id>,<node id>' }));
      if (!existsSync(graphPath)) return send(404, JSON.stringify({ error: 'no graph yet — sync sources in settings or run farsight ingest' }));
      let db: SnapshotDb;
      try {
        db = openHistory(ws);
      } catch (err) {
        return send(503, JSON.stringify({ error: (err as Error).message }));
      }
      try {
        const g = loadJourneyGraph(graphPath);
        // a part's file, from the graph — only parts of this repository
        const parts = ids.map((id) => g.index.byId.get(id)).filter((n): n is GraphNode => !!n && (n.loc?.repo ?? repo) === repo)
          .map((n) => ({ node: n.id, ...(n.loc?.path ? { path: n.loc.path } : {}) }));
        const read = db.commitCount(repo);
        const commits = read ? db.commitsTouching(repo, parts) : [];
        const lines = commits.filter((c) => c.parts.some((p) => p.how === 'lines')).length;
        return send(200, JSON.stringify({
          repo,
          // how many commits the history holds for this repository: 0 = never read, which is not "none touched"
          read,
          parts: parts.map((p) => p.node),
          commits: commits.map((c) => ({ ...c, keys: db.keysForCommit(repo, c.sha).map((k) => k.key).filter((k, i, a) => a.indexOf(k) === i) })),
          counted: {
            commits: counted(commits.length, 'map.prop.changes.countCommits', 'journey.scopeHere', 'server /api/history/touching · commit_node + commit_file', {
              bizUnit: 'map.prop.changes.countCommits',
              breakdown: [{ key: 'count.part.commitLines', n: lines }, { key: 'count.part.commitFile', n: commits.length - lines }],
            }),
          },
        }));
      } finally {
        db.close();
      }
    }
    // ── Change history (docs/proposals/change-history-2026-09.md §7, chunk H5) ──
    if (url.startsWith('/api/history') && req.method === 'GET') {
      // the snapshot spine with each sync's commits, from the same folds
      // `farsight history` prints. Read-only: it writes no commit row, and it
      // never walks a log — `farsight history` does that, so a slow history
      // cannot slow a request (§8).
      const u = new URL(url, 'http://localhost');
      const repo = u.searchParams.get('repo');
      if (!repo) {
        const names = knownRepos(ws, graphPath);
        return send(400, JSON.stringify({ error: `missing ?repo=<source name>${names.length ? ` — this workspace knows: ${names.join(', ')}` : ' — and .farsight/settings.json declares no local source'}` }));
      }
      let db: SnapshotDb;
      try {
        db = openHistory(ws);
      } catch (err) {
        // node:sqlite missing: an honest degraded mode, never a fabricated empty spine
        return send(503, JSON.stringify({ error: (err as Error).message }));
      }
      try {
        const spine = db.commitSpine(repo);
        const said = spineSentences(spine);
        const notes: { level: 'note' | 'warn'; text: string }[] = [];

        // First, before anything else: has a history been read for this repository at
        // all? Nothing below is a measurement until one has, and no row can say
        // whether its commit is in it — so this sentence governs every other.
        if (said.historyUnread) notes.push(said.historyUnread);

        // the present state of the repository: two O(1) probes, not a log walk
        const root = checkoutRoot(ws, graphPath, repo);
        const head = root ? gitHeadRef(root) : undefined;
        const shallow = root ? gitShallow(root) : undefined;
        if (!root) {
          notes.push({ level: 'warn', text: `no checkout recorded for ${repo} — the spine below is what the database holds; whether this repository is shallow, which ancestry HEAD walks, and what has been committed since the last sync cannot be read without the code` });
        } else if (head && !head.available) {
          // §8's no-git row: syncs only, and every commit column reads "not indexed"
          notes.push({ level: 'warn', text: `${GIT_ABSENT_WORD[head.reason]}${head.detail ? ` — git said: ${head.detail}` : ''}` });
          notes.push({ level: 'note', text: 'the snapshot spine below is unchanged; every commit it cannot name reads "not indexed"' });
        }
        // then the unindexed count: a history holding commits no sync ingested says
        // so before any row is read as a complete account
        if (said.unindexed) notes.push(said.unindexed);
        if (shallow?.available && shallow.shallow) notes.push({ level: 'warn', text: shallowFloorSentence(oldestKnownCommit(spine)) });
        for (const key of ['syncs', 'noneRecorded', 'unanchored', 'outsideReach', 'belowFloor', 'noSnapshots', 'borrowed'] as const) {
          const sentence = said[key];
          if (sentence) notes.push(sentence);
        }

        // ?from=&to= adds the git narrative for that sync range — drawn beside the
        // measured diff, never merged into it (§2). Defaults mirror `farsight diff`:
        // to = latest, from = the sync before it.
        const toParam = u.searchParams.get('to');
        const fromParam = u.searchParams.get('from');
        let range: unknown;
        if (toParam || fromParam) {
          const to = resolveSync(db, toParam ?? 'latest');
          if (to === null) return send(400, JSON.stringify({ error: `to expects sync:<N> or latest (got "${toParam}")` }));
          const from = fromParam ? resolveSync(db, fromParam) : db.previous(to) ?? null;
          if (from === null) {
            return send(400, JSON.stringify({ error: fromParam ? `from expects sync:<N> or latest (got "${fromParam}")` : `no snapshot before sync:${to} to compare against — pass from=sync:<N>` }));
          }
          try {
            const r = db.commitsBetween(repo, from, to);
            range = {
              base: r.base, head: r.head,
              ...(r.baseCommit ? { baseCommit: r.baseCommit } : {}),
              ...(r.headCommit ? { headCommit: r.headCommit } : {}),
              commits: r.commits.map((c) => ({ sha: c.sha, at: c.at, author: c.author, email: c.email, subject: c.subject, merge: c.merge, indexed: c.indexed, syncs: c.syncs })),
              // how many of them no sync ever ingested — "not indexed", never a zero
              unindexed: r.unindexed,
              incomplete: r.incomplete,
              // one sentence per reason the range is only partly knowable
              notes: r.incomplete.map((why) => ({ level: 'warn' as const, text: INCOMPLETE_SENTENCE[why] })),
              // What this range did to files — the only granularity these rows have
              // (§2). It answers §6's second question, why a sync reported hundreds of
              // removals when nothing was deleted: node ids carry the path, so a file
              // git matched as moved reads as a removal plus an addition, and
              // `renamed` / `identical` are what say so.
              //
              // **Absent, never zeroes, when no history has been read**: `touched: 0`
              // would assert that nothing touched a file, which is the one claim an
              // unread history cannot make — the rule `attributeChanges` follows.
              ...(spine.historyRead ? { files: fileFacts(db, repo, r.commits.map((c) => c.sha)) } : {}),
            };
          } catch (err) {
            // a pruned or unknown sync explains itself rather than 500ing
            return send(404, JSON.stringify({ error: (err as Error).message }));
          }
        }

        return send(200, JSON.stringify({
          generatedAt: new Date().toISOString(),
          repo,
          root: root ?? null,
          // what git log from here would walk — "ancestry of <sha>" on a detached HEAD (§8)
          title: head ? headTitle(head) ?? null : null,
          head: !head ? null
            : head.available ? { available: true, sha: head.sha, ...(head.ref ? { ref: head.ref } : {}), detached: head.detached }
            : { available: false, reason: head.reason, word: GIT_ABSENT_WORD[head.reason], ...(head.detail ? { detail: head.detail } : {}) },
          // null, never false: a shallow check that could not run has not said "not shallow"
          shallow: shallow?.available ? shallow.shallow : null,
          // has any commit been read for this repository? With none, every containment
          // question is unanswerable and every count here is a floor, not a measurement
          historyRead: spine.historyRead,
          bound: spine.bound,
          commits: spine.commits,
          unindexed: spine.unindexed,
          syncs: spine.rows.length,
          distinct: spine.distinct,
          reindexed: spine.reindexed,
          // rows where the absence is a fact about the sync: it walked this source and
          // stamped nothing, or it did not walk it
          withoutCommit: spine.withoutCommit,
          // of those, how many did not include this source at all (H3b's third row state)
          notInSync: spine.notInSync,
          // and, kept apart from both, the rows whose commit is unplaceable only
          // because no history has been read — never folded into withoutCommit
          withoutHistory: spine.withoutHistory,
          unverified: spine.unverified,
          before: spine.before.length,
          after: spine.after.length,
          spine: spine.rows.map(historyRowOut),
          notes,
          ...(range ? { range } : {}),
        }));
      } catch (err) {
        return send(500, JSON.stringify({ error: (err as Error).message }));
      } finally {
        // one handle per request: /api/sync opens the same file to write
        db.close();
      }
    }
    if (url.startsWith('/api/diff') && req.method === 'GET') {
      // the frozen `farsight-diff v1` document between two syncs — the same
      // `diffGraphs` fold `farsight diff` renders, with H4's optional
      // attribution field when attribute=1 and NO attribution key without it.
      const u = new URL(url, 'http://localhost');
      let db: SnapshotDb;
      try {
        db = openHistory(ws);
      } catch (err) {
        return send(503, JSON.stringify({ error: (err as Error).message }));
      }
      try {
        const toParam = u.searchParams.get('to') ?? 'latest';
        const to = resolveSync(db, toParam);
        if (to === null) return send(400, JSON.stringify({ error: `to expects sync:<N> or latest (got "${toParam}") — or there are no snapshots yet: run farsight ingest, or sync sources in settings` }));
        const fromParam = u.searchParams.get('from');
        const from = fromParam ? resolveSync(db, fromParam) : db.previous(to) ?? null;
        if (from === null) {
          return send(400, JSON.stringify({ error: fromParam ? `from expects sync:<N> or latest (got "${fromParam}")` : `no snapshot before sync:${to} to diff against — pass from=sync:<N>` }));
        }
        let base, head;
        try {
          base = db.read(from);
          head = db.read(to);
        } catch (err) {
          // pruned or never-existed: the store's own sentence, not a 500
          return send(404, JSON.stringify({ error: (err as Error).message }));
        }
        const limit = Number(u.searchParams.get('limit'));
        const diff = diffGraphs(base.store, head.store, {
          changes: db.changedBetween(base.ref.sync, head.ref.sync),
          ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
        });
        const attribute = /^(1|true|yes)$/.test(u.searchParams.get('attribute') ?? '');
        const format = u.searchParams.get('format') ?? 'json';
        if (!['json', 'sarif', 'md'].includes(format)) return send(400, JSON.stringify({ error: `unknown format "${format}" (json|sarif|md)` }));

        let out = diff;
        if (attribute) {
          const repoParam = u.searchParams.get('repo');
          const attributed = attributeDiffOver(diff, db, {
            base: base.ref.sync,
            head: head.ref.sync,
            ...(repoParam ? { repos: [repoParam] } : {}),
            checkout: (r) => attributionCheckout(ws, graphPath, r),
          });
          out = attributed.diff;
          // The document is frozen and its schema is additionalProperties:false, so
          // the caveats cannot ride inside it — the CLI puts them on stderr, and here
          // they ride as ASCII headers plus a pointer at the surface whose job is the
          // narrative. Attribution is file-level and is not proof of cause; a reader
          // who sees only the commits must still be able to find that out.
          res.setHeader('X-Farsight-Attribution', 'level=file; the commits that touched the file a change lives in, not proof of cause');
          res.setHeader('X-Farsight-Attribution-Notes', String(attributed.notes.length));
          res.setHeader('X-Farsight-Attribution-Words', `/api/history?repo=<name>&from=sync:${base.ref.sync}&to=sync:${head.ref.sync}`);
        }
        if (format === 'sarif') return send(200, JSON.stringify(toSarif(out), null, 2));
        if (format === 'md') return send(200, toMarkdown(out), 'text/markdown; charset=utf-8');
        return send(200, JSON.stringify(out, null, 2));
      } catch (err) {
        return send(500, JSON.stringify({ error: (err as Error).message }));
      } finally {
        db.close();
      }
    }
    if (url.startsWith('/api/changes') && req.method === 'GET') {
      // The Changes surface's own fold (chunk H7): the frozen `farsight-diff v1`
      // document **nested** under `diff`, plus the words that belong beside it.
      //
      // Why nested instead of /api/diff growing keys: the document is frozen and its
      // schema is additionalProperties:false, so a sentence cannot ride inside it —
      // H5 put the attribution caveats in response headers for that reason. And the
      // sentences must not be re-worded in the viewer: `changeSentence` is one fold in
      // the core, so the HUD, the CLI's markdown and SARIF say the same thing about one
      // change. Nesting keeps the contract byte-identical — `diff` here is exactly what
      // /api/diff returns — and lets the words travel as data.
      //
      // Attribution is always computed: it is file-level provenance, the surface draws
      // it in the code register and its *notes* are what stop an empty commit list from
      // reading as "nothing touched this". A repository with no history read gets no
      // field at all, and says so in a note.
      const u = new URL(url, 'http://localhost');
      let db: SnapshotDb;
      try {
        db = openHistory(ws);
      } catch (err) {
        return send(503, JSON.stringify({ error: (err as Error).message }));
      }
      try {
        const toParam = u.searchParams.get('to') ?? 'latest';
        const to = resolveSync(db, toParam);
        if (to === null) return send(400, JSON.stringify({ error: `to expects sync:<N> or latest (got "${toParam}") — or there are no snapshots yet: run farsight ingest, or sync sources in settings` }));
        const fromParam = u.searchParams.get('from');
        const from = fromParam ? resolveSync(db, fromParam) : db.previous(to) ?? null;
        if (from === null) {
          return send(400, JSON.stringify({ error: fromParam ? `from expects sync:<N> or latest (got "${fromParam}")` : `no snapshot before sync:${to} to compare against — pass from=sync:<N>` }));
        }
        let base, head;
        try {
          base = db.read(from);
          head = db.read(to);
        } catch (err) {
          return send(404, JSON.stringify({ error: (err as Error).message }));
        }
        const limit = Number(u.searchParams.get('limit'));
        const diff = diffGraphs(base.store, head.store, {
          changes: db.changedBetween(base.ref.sync, head.ref.sync),
          ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
        });
        const repoParam = u.searchParams.get('repo');
        const attributed = attributeDiffOver(diff, db, {
          base: base.ref.sync,
          head: head.ref.sync,
          ...(repoParam ? { repos: [repoParam] } : {}),
          checkout: (r) => attributionCheckout(ws, graphPath, r),
        });
        return send(200, JSON.stringify({
          generatedAt: new Date().toISOString(),
          // the two ends as numbers, because the document's `base`/`head` are labels for
          // reading and the surface needs the syncs to link and to name
          baseSync: base.ref.sync,
          headSync: head.ref.sync,
          diff: attributed.diff,
          // one sentence per change, from the core's `changeSentence` — the same words
          // `farsight diff --format md` prints
          sentences: Object.fromEntries(attributed.diff.changes.map((c) => [c.id, changeSentence(c)])),
          attribution: { level: 'file', header: attributed.header, notes: attributed.notes },
        }));
      } catch (err) {
        return send(500, JSON.stringify({ error: (err as Error).message }));
      } finally {
        db.close();
      }
    }
    if (url.startsWith('/api/work')) {
      // work items (docs/proposals/work-items-sync.md §9, §10): the routes live in work.ts
      handleWorkRoute(req, url, {
        ws, graphPath,
        sources: () => loadSettings(ws).sources as WorkSettingsSource[],
        graph: () => {
          if (!existsSync(graphPath)) return null;
          try { const g = loadJourneyGraph(graphPath); return { index: g.index, roots: g.roots, meta: g.meta }; } catch { return null; }
        },
      })
        .then((a) => (a ? send(a.code, JSON.stringify(a.body)) : send(404, JSON.stringify({ error: 'not found' }))))
        .catch((err) => send(500, JSON.stringify({ error: (err as Error).message })));
      return;
    }
    if (url === '/api/settings' && req.method === 'GET') {
      return send(200, JSON.stringify(loadSettings(ws)));
    }
    if (url === '/api/settings' && req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const problem = settingsProblem(parsed);
          if (problem) return send(400, JSON.stringify({ error: problem }));
          saveSettings(ws, parsed);
          send(200, JSON.stringify({ ok: true }));
        } catch (err) {
          send(400, JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }
    if (url === '/api/sync' && req.method === 'POST') {
      syncSources(ws, loadSettings(ws), graphPath)
        .then((outcome) => send(200, JSON.stringify(outcome)))
        .catch((err) => send(500, JSON.stringify({ error: (err as Error).message })));
      return;
    }
    if (url === '/api/modelhub/state' && req.method === 'GET') {
      // fail-soft runtime overlay: reader never throws, but guard the response too
      readModelHubState()
        .then((state) => send(200, JSON.stringify(state)))
        .catch((err) => send(500, JSON.stringify({ error: (err as Error).message })));
      return;
    }
    send(404, JSON.stringify({ error: 'not found' }));
  });

  // a port already serving another workspace's graph must say so, not render a look-alike:
  // the "stale graph from another workspace" round a consumer lost was exactly this
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;
    fetch(`http://127.0.0.1:${port}/graph`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .then((g: { meta?: { workspace?: string; graphPath?: string; generatedAt?: string } }) => {
        const m = g?.meta ?? {};
        console.error(`farsight: port ${port} is already serving${m.workspace ? ` workspace "${m.workspace}"` : ' another Farsight'}${m.graphPath ? ` (${m.graphPath}${m.generatedAt ? `, generated ${m.generatedAt}` : ''})` : ''} — this workspace is ${ws}. Stop it, or pass --port.`);
      })
      .catch(() => console.error(`farsight: port ${port} is in use by something that is not a Farsight server — pass --port.`))
      .finally(() => process.exit(1));
  });
  // bind loopback only — Model Hub + graph are local-only surfaces (security posture)
  server.listen(port, '127.0.0.1', () => {
    console.log(`farsight: http://localhost:${port}  (graph: ${graphPath}, workspace: ${ws})`);
  });
}
