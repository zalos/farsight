// The Next middleware applicability pack (PR 14). For one captured source and its parser evidence it finds the Next
// projects, resolves the installed versions from lockfiles, reads the middleware handler and `config` exports and
// next.config statically, and decides for every App Router route and page surface the parser placed whether the
// middleware runs for all, none or only some of the requests that reach it.
//
// Applicability is not effect. A surface the middleware runs for is *matched*, and every property stays `unknown`
// (`sentinel.next.reason.effectNotEstablished`): what the body does with a request is not read here, and a
// middleware's name or presence is not authentication or authorization evidence. Only exclusion resolves: a surface
// none of whose own request paths the matcher reaches gets `does-not-apply` for each property, citing the matcher
// bytes (a middleware rewrite from a matched path may still land there; that never makes it protected). So no
// excluded route is ever marked protected, and nothing this pack emits is `applies`.
//
// Inputs are the snapshot envelope, the parser's analysis of the same snapshot and source (PR 05), and a reader of
// captured bytes by content id (the store). Every read is hash-checked against its content id. No application code
// runs; Farsight's broad middleware guard edges are never consulted.
import { createHash } from 'node:crypto';
import type {
  ArtifactId, ControlFactsEnvelope, ControlFact, ControlProperty, DirectoryBoundaryEntry, ScopedReason, SnapshotEnvelope,
  SourceEvidence, Digest,
} from '../../contracts/index.js';
import { plannerAnalysisFrom } from '../../planner/adapters.js';
import type { SourceAnalysis } from '../../snapshot/parser.js';
import { digestOf } from '../../store/ledger-json.js';
import { validateEnvelope } from '../../validate.js';
import { readMiddleware, readNextConfig, type ByteRange, type MiddlewareRead, type NextConfigRead } from './config.js';
import { decideCaseStable, parseMatcherSource, routeLanguage, type SegmentLanguage } from './pattern.js';
import { NEXT_ANALYSIS_SCHEMA, NEXT_PACK_DIGEST, NEXT_SUPPORT } from './support.js';
import { PACKAGES, resolveVersions, type CapturedFile, type PackageName, type ResolvedVersion } from './version.js';
import { NextPackError } from './errors.js';

export const CONTROL_PROPERTIES: readonly ControlProperty[] = Object.freeze([
  'authentication', 'authorization', 'csrf', 'input-validation', 'rate-limit', 'security-headers', 'cors',
]);

/** Reason codes on unknown facts and on frontiers (strings-sentinel-next.ts). */
export const NEXT_REASON_CODES = Object.freeze([
  'sentinel.next.reason.effectNotEstablished', 'sentinel.next.reason.partialMatch', 'sentinel.next.reason.conditionalMatcher',
  'sentinel.next.reason.matcherUnsupported', 'sentinel.next.reason.matcherInvalid', 'sentinel.next.reason.matcherDynamic',
  'sentinel.next.reason.caseAmbiguous', 'sentinel.next.reason.routeUnsupported', 'sentinel.next.reason.notRoutable',
  'sentinel.next.reason.versionUnknown', 'sentinel.next.reason.versionUnsupported', 'sentinel.next.reason.nextConfigUnsupported',
  'sentinel.next.reason.middlewareUnresolved', 'sentinel.next.reason.runtimeUnsupported', 'sentinel.next.reason.scopeUnknown',
  'sentinel.next.frontier.pagesRouter', 'sentinel.next.frontier.surfaceNotInGraph', 'sentinel.next.frontier.outsideApp',
  'sentinel.next.frontier.misplacedMiddleware', 'sentinel.next.frontier.factLimit', 'sentinel.next.frontier.packageJsonInvalid',
  'sentinel.next.frontier.noRouter', 'sentinel.next.frontier.directoryUnlisted',
] as const);
export type NextReasonCode = typeof NEXT_REASON_CODES[number];

/** How the middleware relates to the requests that reach one surface. */
export type Applicability = 'matched' | 'excluded' | 'partial' | 'no-middleware' | 'unknown';

export interface SurfaceApplicability {
  readonly surfaceId: string;
  readonly kind: string;
  readonly relativePath: string;
  /** The request paths the file serves, in the file-system form (`/api/[id]`), when the subset reads them. */
  readonly requestPattern?: string;
  readonly applicability: Applicability;
  readonly reasonCode?: NextReasonCode;
  /** One request path of the surface the matcher reaches and one it does not, when they exist. */
  readonly matchedExample?: string;
  readonly unmatchedExample?: string;
  readonly evidence: readonly SourceEvidence[];
  /** The digest of everything that decided this surface: change any of it and the fact is stale. */
  readonly influenceDigest: Digest;
}

export interface NextProject {
  /** The folder holding the project's package.json ('' for the source root). */
  readonly projectDir: string;
  /** The folder holding the router directory (the project, or its src/). null when none was found. */
  readonly routerBase: string | null;
  readonly versions: Readonly<Record<PackageName, ResolvedVersion>>;
  readonly supported: boolean;
  readonly middleware: null | { readonly relativePath: string; readonly content: ArtifactId; readonly read: MiddlewareRead | { readonly ok: false; readonly reason: 'not-captured' | 'ambiguous' | 'not-parsed'; readonly detail: string } };
  readonly nextConfig: null | { readonly relativePath: string; readonly content?: ArtifactId; readonly read: NextConfigRead };
  readonly surfaces: readonly SurfaceApplicability[];
  readonly frontiers: readonly ScopedReason[];
  readonly registrationDigest: Digest;
}

export interface NextPackResult {
  readonly schema: typeof NEXT_ANALYSIS_SCHEMA;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly analysisFingerprint: string;
  readonly packDigest: Digest;
  readonly projects: readonly NextProject[];
  /** Source-wide frontiers (surfaces no Next project routes). */
  readonly frontiers: readonly ScopedReason[];
  /** One control-facts envelope per project with a router. */
  readonly envelopes: readonly ControlFactsEnvelope[];
}

export interface NextPackInput {
  readonly snapshot: SnapshotEnvelope;
  /** The parser's analysis of this snapshot's source (snapshot/parser `parseSnapshot`). */
  readonly analysis: SourceAnalysis;
  /** Captured bytes by content id; the store's `readArtifact`. Every result is hash-checked. */
  readonly read: (content: ArtifactId) => Promise<Uint8Array>;
  /** The properties to emit facts for; default every ControlProperty. */
  readonly properties?: readonly ControlProperty[];
}

const MAX_FACTS = 100_000;
const MAX_FRONTIERS = 10_000;
/** Largest middleware, next.config or package.json read; larger is unknown. */
export const MAX_CONFIG_BYTES = 1024 * 1024;
const MIDDLEWARE_EXTS = ['ts', 'js', 'tsx', 'jsx'];
const NEXT_CONFIG_EXTS = ['js', 'mjs', 'cjs', 'ts'];
const SURFACE_FILE = /^(page|route)\.(tsx|ts|jsx|js)$/;
const PARSER_SURFACE_FILE = /^(page\.(tsx|ts|jsx|js)|route\.(ts|js))$/;

const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const under = (path: string, dir: string) => (dir === '' ? true : path === dir || path.startsWith(dir + '/'));
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const byPath = <T extends { relativePath: string }>(a: T, b: T) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);

/** A frontier scope: `<sourceId>:<path>`, or a digest of the path when it holds characters a scope may not. */
const scope = (sourceId: string, path: string) =>
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path) ? `${sourceId}:#${sha(path).slice(7, 31)}` : `${sourceId}:${path}`;

/**
 * Analyzes one source. Throws NextPackError when the inputs are inconsistent (another snapshot, a forged analysis,
 * bytes that do not match their content id); every limitation of the subset is a frontier or an unknown, not an error.
 */
export async function analyzeNext(input: NextPackInput): Promise<NextPackResult> {
  const { snapshot, analysis } = input;
  if (!validateEnvelope('snapshot', snapshot).ok) throw new NextPackError('sentinel.next.invalidInput', 'the snapshot is not a valid sentinel-snapshot/draft-1 envelope');
  const view = (() => {
    try { return plannerAnalysisFrom(analysis); } catch (e) { throw new NextPackError('sentinel.next.invalidInput', (e as Error).message); }
  })();
  if (view.snapshotId !== snapshot.id) throw new NextPackError('sentinel.next.invalidInput', 'the parser evidence is for another snapshot');
  const sourceId = view.sourceId;
  if (!snapshot.sources.some(s => s.sourceId === sourceId)) throw new NextPackError('sentinel.next.invalidInput', 'the parser evidence names a source the snapshot did not capture');
  const properties = [...new Set(input.properties ?? CONTROL_PROPERTIES)];
  if (properties.length === 0 || properties.some(p => !CONTROL_PROPERTIES.includes(p))) throw new NextPackError('sentinel.next.invalidInput', 'properties must name ControlProperty values');

  // ---- the captured inventory of this source ----
  const entries = snapshot.entries.filter(e => e.sourceId === sourceId);
  const files = new Map<string, CapturedFile>();
  for (const e of entries) if (e.kind === 'file' && e.disposition === 'included') files.set(e.relativePath, { relativePath: e.relativePath, content: e.content, bytes: e.bytes });
  const recorded = new Set(entries.map(e => e.relativePath));
  const boundaries = entries.filter((e): e is DirectoryBoundaryEntry => e.kind === 'directory-boundary');
  const parserClass = new Map(view.files.map(f => [f.path, f.class]));
  const cache = new Map<string, Uint8Array>();
  const read = async (f: CapturedFile): Promise<Uint8Array> => {
    const hit = cache.get(f.content);
    if (hit) return hit;
    const bytes = await input.read(f.content);
    if (sha(bytes) !== f.content || bytes.byteLength !== f.bytes) throw new NextPackError('sentinel.next.integrity', `${f.relativePath}: the bytes read do not match the captured content id`);
    cache.set(f.content, bytes);
    return bytes;
  };
  const evidence = (f: CapturedFile, bytes: Uint8Array, span: ByteRange): SourceEvidence => ({
    snapshotId: snapshot.id, sourceId, relativePath: f.relativePath, content: f.content as ArtifactId,
    span: { startByte: span.startByte, endByte: span.endByte }, quoteDigest: sha(bytes.subarray(span.startByte, span.endByte)) as Digest,
  });

  // ---- projects: a package.json that depends on next ----
  const sourceFrontiers: ScopedReason[] = [];
  const projectDirs: string[] = [];
  for (const f of [...files.values()].sort(byPath)) {
    if (base(f.relativePath) !== 'package.json' || f.relativePath.split('/').includes('node_modules')) continue;
    const pkg = await readJson(f, read);
    if (pkg === null) { sourceFrontiers.push({ scopeId: scope(sourceId, f.relativePath), reasonCode: 'sentinel.next.frontier.packageJsonInvalid' }); continue; }
    if (dependsOnNext(pkg)) projectDirs.push(dirOf(f.relativePath));
  }

  const projects: NextProject[] = [];
  const envelopes: ControlFactsEnvelope[] = [];
  const claimed = new Set<string>();
  // Deepest first, so a nested project claims its own surfaces before an enclosing one.
  for (const projectDir of [...projectDirs].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))) {
    const pkg = (await readJson(files.get(join(projectDir, 'package.json'))!, read))!;
    const frontiers: ScopedReason[] = [];
    const frontier = (path: string, reasonCode: NextReasonCode) => frontiers.push({ scopeId: scope(sourceId, path), reasonCode });
    const hasUnder = (dir: string) => [...recorded].some(p => p.startsWith(dir + '/')) || boundaries.some(b => b.relativePath === dir);
    const routerBase = ['app', 'pages'].some(d => hasUnder(join(projectDir, d))) ? projectDir
      : ['app', 'pages'].some(d => hasUnder(join(join(projectDir, 'src'), d))) ? join(projectDir, 'src') : null;
    const versions = await resolveVersions({ projectDir, files, recorded, read, packageJson: pkg, pins: NEXT_SUPPORT.packages });
    // Supported means the exact pinned packages: their versions and their registry content identity.
    const supported = PACKAGES.every(p => {
      const v = versions[p];
      return v.state === 'resolved' && v.version === NEXT_SUPPORT.packages[p].version && v.integrity === NEXT_SUPPORT.packages[p].integrity;
    });
    const nextVersion = versions.next.state === 'resolved' ? versions.next.version : null;

    // Unlisted folders that could hold the router, the middleware or routes.
    const unlisted = routerBase === null ? [] : boundaries.filter(b => under(join(routerBase, 'app'), b.relativePath) || under(b.relativePath, join(routerBase, 'app'))
      || b.relativePath === routerBase || (routerBase !== '' && under(routerBase, b.relativePath)));
    for (const b of unlisted) frontier(b.relativePath, 'sentinel.next.frontier.directoryUnlisted');
    const baseUnlisted = routerBase !== null && unlisted.some(b => under(routerBase, b.relativePath) || b.relativePath === join(routerBase, 'app'));

    // ---- middleware ----
    let middleware: NextProject['middleware'] = null;
    let mwBytes: Uint8Array | undefined;
    let mwFile: CapturedFile | undefined;
    if (routerBase !== null) {
      const candidates = MIDDLEWARE_EXTS.map(x => join(routerBase, `middleware.${x}`)).filter(p => recorded.has(p));
      // Next 14 loads middleware only beside the router directory; a file elsewhere in the project never runs.
      const misplaced = [projectDir, join(projectDir, 'src'), join(routerBase, 'app')].filter(d => d !== routerBase)
        .flatMap(d => MIDDLEWARE_EXTS.map(x => join(d, `middleware.${x}`))).filter(p => recorded.has(p));
      for (const p of misplaced) frontier(p, 'sentinel.next.frontier.misplacedMiddleware');
      if (candidates.length > 1) {
        middleware = { relativePath: candidates[0]!, content: '' as ArtifactId, read: { ok: false, reason: 'ambiguous', detail: `${candidates.length} middleware files` } };
      } else if (candidates.length === 1) {
        const path = candidates[0]!;
        const f = files.get(path);
        if (!f || f.bytes > MAX_CONFIG_BYTES) {
          middleware = { relativePath: path, content: (f?.content ?? '') as ArtifactId, read: { ok: false, reason: 'not-captured', detail: 'the middleware bytes were not captured or are too large' } };
        } else if (parserClass.get(path) !== 'parsed') {
          middleware = { relativePath: path, content: f.content as ArtifactId, read: { ok: false, reason: 'not-parsed', detail: `the parser classed it ${parserClass.get(path) ?? 'absent'}` } };
        } else {
          mwFile = f;
          mwBytes = await read(f);
          middleware = { relativePath: path, content: f.content as ArtifactId, read: await readMiddleware(path, mwBytes) };
        }
      }
    }

    // ---- next.config ----
    let nextConfig: NextProject['nextConfig'] = null;
    const configs = NEXT_CONFIG_EXTS.map(x => join(projectDir, `next.config.${x}`)).filter(p => recorded.has(p));
    if (configs.length > 1) nextConfig = { relativePath: configs[0]!, read: { state: 'unsupported', detail: `${configs.length} next.config files` } };
    else if (configs.length === 1) {
      const path = configs[0]!;
      const f = files.get(path);
      if (path.endsWith('.ts')) nextConfig = { relativePath: path, ...(f ? { content: f.content as ArtifactId } : {}), read: { state: 'unsupported', detail: 'Next 14 does not read next.config.ts' } };
      else if (!f || f.bytes > MAX_CONFIG_BYTES) nextConfig = { relativePath: path, read: { state: 'unsupported', detail: 'next.config was not captured or is too large' } };
      else nextConfig = { relativePath: path, content: f.content as ArtifactId, read: await readNextConfig(path, await read(f)) };
    }

    // ---- surfaces ----
    const appDir = routerBase === null ? null : join(routerBase, 'app');
    const mine = appDir === null ? [] : view.surfaces.filter(s => !claimed.has(s.nodeId) && under(s.path, appDir) && s.path !== appDir
      && PARSER_SURFACE_FILE.test(base(s.path)));
    for (const s of mine) claimed.add(s.nodeId);
    if (routerBase === null) frontier(projectDir || '.', 'sentinel.next.frontier.noRouter');
    if (routerBase !== null && hasUnder(join(routerBase, 'pages'))) frontier(join(routerBase, 'pages'), 'sentinel.next.frontier.pagesRouter');
    if (appDir !== null) {
      const placed = new Set(mine.map(s => s.path));
      const unplaced = [...recorded].filter(p => under(p, appDir) && SURFACE_FILE.test(base(p)) && !placed.has(p)
        && !projectDirs.some(d => d !== projectDir && d.length > projectDir.length && under(p, d))).sort();
      for (const p of unplaced) frontier(p, 'sentinel.next.frontier.surfaceNotInGraph');
    }

    // ---- the decisions ----
    const mwEvidence: SourceEvidence[] = [];
    let matcher: { must: SegmentLanguage; may: SegmentLanguage; unsupported: 'sentinel.next.reason.matcherUnsupported' | 'sentinel.next.reason.matcherInvalid' | null; evidence: SourceEvidence[] } | 'all' | NextReasonCode | 'none';
    const mw = middleware?.read;
    if (!supported) matcher = versions.next.state === 'resolved' && versions.react.state === 'resolved' && versions['react-dom'].state === 'resolved' ? 'sentinel.next.reason.versionUnsupported' : 'sentinel.next.reason.versionUnknown';
    else if (baseUnlisted) matcher = 'sentinel.next.reason.scopeUnknown';
    else if (nextConfig && nextConfig.read.state !== 'empty') matcher = 'sentinel.next.reason.nextConfigUnsupported';
    else if (!middleware) matcher = 'none';
    else if (!mw || !mw.ok) matcher = 'sentinel.next.reason.middlewareUnresolved';
    else {
      mwEvidence.push(evidence(mwFile!, mwBytes!, mw.exportSpan));
      const cfg = mw.config;
      if (cfg.state === 'absent') matcher = 'all';
      else if (cfg.state !== 'static') {
        matcher = cfg.state === 'dynamic' ? 'sentinel.next.reason.matcherDynamic'
          : cfg.state === 'invalid' ? 'sentinel.next.reason.matcherInvalid' : 'sentinel.next.reason.runtimeUnsupported';
      }
      else if (cfg.matcher === null) { mwEvidence.push(evidence(mwFile!, mwBytes!, cfg.span)); matcher = 'all'; }
      else {
        const must: (readonly import('./pattern.js').SegmentItem[])[] = [];
        const may: (readonly import('./pattern.js').SegmentItem[])[] = [];
        let unsupported: 'sentinel.next.reason.matcherUnsupported' | 'sentinel.next.reason.matcherInvalid' | null = null;
        for (const e of cfg.matcher.entries) {
          const parsed = e.invalid || e.source === undefined ? { ok: false as const, reason: 'invalid' as const } : parseMatcherSource(e.source);
          if (!parsed.ok) {
            if (parsed.reason === 'invalid') unsupported = 'sentinel.next.reason.matcherInvalid';
            else unsupported ??= 'sentinel.next.reason.matcherUnsupported';
            continue;
          }
          may.push(...parsed.language);
          if (!e.conditional) must.push(...parsed.language);
        }
        matcher = { must, may, unsupported, evidence: [evidence(mwFile!, mwBytes!, cfg.matcher.span)] };
      }
    }

    const surfaces: SurfaceApplicability[] = [];
    const surfaceFile = (path: string) => files.get(path);
    for (const s of [...mine].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))) {
      const folders = s.path.slice(appDir!.length + 1).split('/').slice(0, -1);
      const route = routeLanguage(folders);
      const sf = surfaceFile(s.path);
      const influence = digestOf({
        pack: NEXT_PACK_DIGEST, surface: s.nodeId, path: s.path, content: sf?.content ?? null, versions,
        middleware: middleware ? { path: middleware.relativePath, content: middleware.content } : null,
        nextConfig: nextConfig ? { path: nextConfig.relativePath, content: nextConfig.content ?? null } : null,
        matcher: typeof matcher === 'object' ? matcher.evidence.map(e => e.quoteDigest!) : matcher,
      }) as Digest;
      const row = (applicability: Applicability, extra: Partial<SurfaceApplicability> = {}): SurfaceApplicability => ({
        surfaceId: s.nodeId, kind: s.kind, relativePath: s.path, ...(route.ok ? { requestPattern: route.display } : {}),
        applicability, evidence: [], influenceDigest: influence, ...extra,
      });
      if (typeof matcher === 'string' && matcher.startsWith('sentinel.')) { surfaces.push(row('unknown', { reasonCode: matcher as NextReasonCode })); continue; }
      if (matcher === 'none') { surfaces.push(row('no-middleware')); continue; }
      if (!route.ok) {
        surfaces.push(row('unknown', { reasonCode: route.reason === 'not-routable' ? 'sentinel.next.reason.notRoutable' : 'sentinel.next.reason.routeUnsupported' }));
        continue;
      }
      if (matcher === 'all') { surfaces.push(row('matched', { reasonCode: 'sentinel.next.reason.effectNotEstablished', evidence: mwEvidence })); continue; }
      const m = matcher as Exclude<typeof matcher, string>;
      const dMust = decideCaseStable(route.items, m.must);
      const dMay = decideCaseStable(route.items, m.may);
      const ev = [...mwEvidence, ...m.evidence];
      const examples = { ...(dMay.matchedExample ? { matchedExample: dMay.matchedExample } : {}), ...(dMust.unmatchedExample ? { unmatchedExample: dMust.unmatchedExample } : {}) };
      if (dMust.caseAmbiguous || dMay.caseAmbiguous) surfaces.push(row('unknown', { reasonCode: 'sentinel.next.reason.caseAmbiguous', evidence: ev }));
      else if (dMust.coverage === 'all') surfaces.push(row('matched', { reasonCode: 'sentinel.next.reason.effectNotEstablished', evidence: ev, ...examples }));
      else if (m.unsupported === null && dMay.coverage === 'none') surfaces.push(row('excluded', { evidence: m.evidence, ...examples }));
      else if (m.unsupported !== null) surfaces.push(row('unknown', { reasonCode: m.unsupported, evidence: ev, ...examples }));
      else surfaces.push(row('partial', { reasonCode: dMust.coverage === 'none' ? 'sentinel.next.reason.conditionalMatcher' : 'sentinel.next.reason.partialMatch', evidence: ev, ...examples }));
    }

    // ---- the envelope ----
    const registrationDigest = digestOf({
      pack: NEXT_PACK_DIGEST, analysis: view.analysisFingerprint, projectDir, routerBase,
      packageJson: files.get(join(projectDir, 'package.json'))!.content,
      lockfiles: PACKAGES.map(p => versions[p].lockfile ?? null),
      middleware: middleware ? { path: middleware.relativePath, content: middleware.content } : null,
      nextConfig: nextConfig ? { path: nextConfig.relativePath, content: nextConfig.content ?? null } : null,
      routerFiles: appDir === null ? [] : [...recorded].filter(p => under(p, appDir)).sort().map(p => [p, files.get(p)?.content ?? null]),
      unlisted: unlisted.map(b => b.relativePath).sort(),
    }) as Digest;
    const perSurface = properties.length;
    const room = Math.floor(MAX_FACTS / perSurface);
    if (surfaces.length > room) frontier(appDir ?? projectDir, 'sentinel.next.frontier.factLimit');
    const facts: ControlFact[] = [];
    for (const s of surfaces.slice(0, room)) {
      if (s.applicability === 'no-middleware') continue;
      for (const property of properties) {
        const id = `next.${sha(`${projectDir}\u0000${s.surfaceId}\u0000${property}`).slice(7, 39)}`;
        const resolved = s.applicability === 'excluded' && nextVersion !== null;
        facts.push({
          id, property, surfaceId: s.surfaceId, order: 0, verdict: resolved ? 'does-not-apply' : 'unknown',
          evidence: [...s.evidence],
          ...(resolved ? {} : { reasonCode: s.reasonCode ?? 'sentinel.next.reason.effectNotEstablished' }),
        });
      }
    }
    if (routerBase !== null) {
      const envelope: ControlFactsEnvelope = {
        schema: 'sentinel-controls/draft-1', snapshotId: snapshot.id, framework: { id: 'next', version: nextVersion },
        packDigest: NEXT_PACK_DIGEST as Digest, environmentDigest: digestOf({ environmentProfile: snapshot.environmentProfileDigest }) as Digest,
        registrationDigest, capability: 'framework-order', facts,
        frontiers: frontiers.slice(0, MAX_FRONTIERS),
      };
      const checked = validateEnvelope('controls', envelope);
      if (!checked.ok) throw new NextPackError('sentinel.next.integrity', `the pack built an invalid envelope: ${checked.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
      envelopes.push(envelope);
    }
    projects.push({ projectDir, routerBase, versions, supported, middleware, nextConfig, surfaces, frontiers, registrationDigest });
  }

  // App-Router-shaped surfaces the parser placed that no Next project routes.
  for (const s of view.surfaces) {
    if (claimed.has(s.nodeId) || !PARSER_SURFACE_FILE.test(base(s.path)) || !/(^|\/)app\//.test(s.path)) continue;
    sourceFrontiers.push({ scopeId: scope(sourceId, s.path), reasonCode: 'sentinel.next.frontier.outsideApp' });
  }
  projects.sort((a, b) => (a.projectDir < b.projectDir ? -1 : a.projectDir > b.projectDir ? 1 : 0));
  envelopes.sort((a, b) => (a.registrationDigest < b.registrationDigest ? -1 : 1));
  return {
    schema: NEXT_ANALYSIS_SCHEMA, snapshotId: snapshot.id, sourceId, analysisFingerprint: view.analysisFingerprint,
    packDigest: NEXT_PACK_DIGEST as Digest, projects, frontiers: dedupe(sourceFrontiers), envelopes,
  };
}

function dedupe(list: ScopedReason[]): ScopedReason[] {
  const seen = new Set<string>();
  return list.filter(f => { const k = `${f.scopeId}\u0000${f.reasonCode}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_FRONTIERS);
}

async function readJson(f: CapturedFile, read: (f: CapturedFile) => Promise<Uint8Array>): Promise<Record<string, unknown> | null> {
  if (f.bytes > MAX_CONFIG_BYTES) return null;
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(f))) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch (e) {
    if (e instanceof NextPackError) throw e;
    return null;
  }
}

const dependsOnNext = (pkg: Record<string, unknown>) => ['dependencies', 'devDependencies'].some(k => {
  const d = pkg[k];
  return !!d && typeof d === 'object' && Object.hasOwn(d as object, 'next');
});
