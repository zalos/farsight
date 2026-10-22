// The Express pack (PR 15): control facts for one captured source, for exactly Express 4.21.2. Surfaces are the
// public parser's canonical route nodes; each route's registration, the layers registered before it on every object
// a request passes through (the application, then each router mount down to the route's router) and the route's own
// handlers before the last are read again from the captured syntax. Express dispatches a request through those
// layers in registration order, so only a layer registered before the route can act on it: a control registered
// after a route never clears a finding for it. A property applies only at a layer whose body this pack reads as a
// refusal for that property; anything the subset cannot resolve is unknown with its reason, never protected.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';
import type { AnalysisArtifact } from '@farsight/code-parser';
import type {
  ArtifactId, ControlFact, ControlFactsEnvelope, ControlVerdict, ScopedReason, SnapshotEnvelope, SourceEvidence,
} from '../../contracts/index.js';
import { validateEnvelope } from '../../validate.js';
import { effectOf, type Property } from './effects.js';
import { buildModel, isTestPath, type At, type ExpressModel, type ExpressObject, type ExpressReason, type Layer } from './model.js';
import { joinPaths, matchMethod, matchPath, segments, stripPrefix } from './patterns.js';
import { EXPRESS_SUPPORT } from './support.js';
import { identifierName, isJsPath, loadParser, parseJs, stringValue, unwrap, walk, type JsFile, type JsNode } from './syntax.js';
import { EXPRESS_VERSION, parseJson, versionScope, type JsonDoc, type VersionVerdict } from './version.js';

export const EXPRESS_PACK = Object.freeze({
  id: 'sentinel.framework.express',
  implementation: 'sentinel-express/draft-1',
  version: EXPRESS_VERSION,
});

export interface ExpressPackInput {
  readonly snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>;
  readonly sourceId: string;
  /** The PR 05 parser evidence for this source: its portable artifact and its index of captured spans. */
  readonly analysis: { readonly artifact: AnalysisArtifact; readonly index: { readonly nodes: readonly { readonly nodeId: string; readonly path: string; readonly content: ArtifactId; readonly line: number; readonly byteSpan?: { readonly startByte: number; readonly endByte: number } }[] } };
  /** Reads a captured file's bytes by content id (the store's `readArtifact`). */
  readonly readContent: (id: ArtifactId) => Promise<Uint8Array>;
  readonly limits?: { readonly maxSourceFiles?: number; readonly maxSourceBytes?: number; readonly maxManifestBytes?: number };
}

export class ExpressPackError extends Error {
  constructor(message: string) { super(message); this.name = 'ExpressPackError'; }
}

const DEFAULT_LIMITS = { maxSourceFiles: 10_000, maxSourceBytes: 64 * 1024 * 1024, maxManifestBytes: 32 * 1024 * 1024 };
const SAFE_BOUNDARIES = new Set(['sentinel.capture.excludedGitInternals', 'sentinel.capture.excludedStore', 'sentinel.capture.excludedDependencyCache']);
const MAX_EVIDENCE = 64;
const PROPERTIES: readonly Property[] = ['authentication', 'authorization'];
const digestOf = (v: unknown) => `sha256:${createHash('sha256').update(canonicalJson(v)).digest('hex')}`;

/** One layer on a request's path to a route's handler, in dispatch order. */
type Entry =
  | { readonly kind: 'refusal'; readonly property: Property; readonly at: At[] }
  | { readonly kind: 'pass-through'; readonly at: At[] }
  | { readonly kind: 'unknown'; readonly properties: readonly Property[]; readonly reason: ExpressReason; readonly at: At[]; readonly mayHandleErrors?: boolean }
  /** An error handler that may resume normal routing: not a position on the normal path, but a way past earlier layers. */
  | { readonly kind: 'resume'; readonly at: At[] };

type PathResult = { readonly ok: true; readonly entries: Entry[]; readonly mounts: At[] } | { readonly ok: false; readonly reason: ExpressReason; readonly at: At[] };

// ---- dispatch, simulated over the registration model ----

function simulateLayers(model: ExpressModel, obj: ExpressObject, template: string, upTo: number, method: string, out: Entry[], depth: number): void {
  if (obj.matching) { out.push({ kind: 'unknown', properties: PROPERTIES, reason: 'sentinel.express.routingSettingUnsupported', at: [obj.matching], mayHandleErrors: true }); return; }
  for (let i = 0; i < upTo && i < obj.layers.length; i++) {
    const layer = obj.layers[i]!;
    layerEntries(model, layer, template, method, out, depth);
  }
}

function pushEffect(model: ExpressModel, file: JsFile, fn: JsNode, match: 'match' | 'unknown', out: Entry[]) {
  const e = effectOf(model.resolveValue(file, fn));
  if (e.kind === 'error-only') { if (e.resumes) out.push({ kind: 'resume', at: e.at }); return; }
  if (match === 'unknown') {
    if (e.kind === 'refusal') out.push({ kind: 'unknown', properties: [e.property], reason: 'sentinel.express.layerMatchUnknown', at: e.at });
    else if (e.kind === 'unknown') out.push({ kind: 'unknown', properties: PROPERTIES, reason: e.reason, at: e.at, mayHandleErrors: e.mayHandleErrors });
    return;
  }
  if (e.kind === 'refusal') out.push({ kind: 'refusal', property: e.property, at: e.at });
  else if (e.kind === 'pass-through') out.push({ kind: 'pass-through', at: e.at });
  else out.push({ kind: 'unknown', properties: PROPERTIES, reason: e.reason, at: e.at, mayHandleErrors: e.mayHandleErrors });
}

function layerEntries(model: ExpressModel, layer: Layer, template: string, method: string, out: Entry[], depth: number): void {
  switch (layer.kind) {
    case 'unknown':
      out.push({ kind: 'unknown', properties: PROPERTIES, reason: layer.reason, at: [layer.at], mayHandleErrors: true });
      return;
    case 'param':
      // A param callback runs before any route whose path has a parameter: not read.
      if (segments(template)?.some(s => s.kind === 'param') ?? true) out.push({ kind: 'unknown', properties: PROPERTIES, reason: 'sentinel.express.paramCallback', at: [layer.at] });
      return;
    case 'middleware': {
      const m = matchPath(template, layer.path, true);
      if (m !== 'no-match') pushEffect(model, layer.file, layer.fn, m, out);
      return;
    }
    case 'mount': {
      const m = matchPath(template, layer.path, true);
      if (m === 'no-match') return;
      const t = layer.target;
      if (t.open) { out.push({ kind: 'unknown', properties: PROPERTIES, reason: 'sentinel.express.registrationDynamic', at: [layer.at, t.open], mayHandleErrors: true }); return; }
      if (m === 'unknown') { out.push({ kind: 'unknown', properties: PROPERTIES, reason: 'sentinel.express.layerMatchUnknown', at: [layer.at], mayHandleErrors: true }); return; }
      if (depth > 32) { out.push({ kind: 'unknown', properties: PROPERTIES, reason: 'sentinel.express.mountCycle', at: [layer.at] }); return; }
      // An earlier router whose prefix matches runs its own matching layers for this request, then falls through.
      simulateLayers(model, t, stripPrefix(template, layer.path)!, t.layers.length, method, out, depth + 1);
      return;
    }
    case 'route': {
      const pm = matchPath(template, layer.path, false);
      const mm = matchMethod(method, layer.methods);
      if (pm === 'no-match' || mm === 'no-match') return;
      if (layer.chained) { out.push({ kind: 'unknown', properties: PROPERTIES, reason: 'sentinel.express.registrationUnsupported', at: [layer.at], mayHandleErrors: true }); return; }
      // An earlier route that matches the same requests runs its handlers first.
      const match = pm === 'match' && mm === 'match' ? 'match' : 'unknown';
      for (const h of layer.handlers) pushEffect(model, layer.file, h, match, out);
      return;
    }
  }
}

/**
 * Express skips the ordinary layers after one that raises an error, up to the next error handler; if that handler
 * calls next() without the error, routing resumes after it. Any earlier layer can raise one (a body parser on a
 * malformed body, for one), so a refusal followed by an error handler that may resume, or by a layer that could be
 * one, does not hold for every request: it becomes unknown. Resume markers hold no position of their own.
 */
function resolveErrorPaths(entries: Entry[]): Entry[] {
  const positional = entries.filter(e => e.kind !== 'resume');
  return positional.map(e => {
    if (e.kind !== 'refusal') return e;
    const after = entries.slice(entries.indexOf(e) + 1);
    const resumer = after.find(x => x.kind === 'resume' || (x.kind === 'unknown' && x.mayHandleErrors));
    return resumer ? { kind: 'unknown', properties: [e.property], reason: 'sentinel.express.errorPathResumes', at: [...e.at, ...resumer.at] } : e;
  });
}

interface Step { readonly obj: ExpressObject; readonly mountIndex?: number }

/** Every chain of mounts from an application down to `obj`. */
function chainsTo(obj: ExpressObject, seen: Set<ExpressObject> = new Set()): Step[][] | 'cycle' {
  if (seen.has(obj)) return 'cycle';
  if (obj.kind === 'app') return [[{ obj }]];
  const next = new Set(seen).add(obj);
  const out: Step[][] = [];
  for (const m of obj.mounts) {
    const up = chainsTo(m.parent, next);
    if (up === 'cycle') return 'cycle';
    for (const c of up) out.push([...c.slice(0, -1), { obj: c[c.length - 1]!.obj, mountIndex: m.index }, { obj }]);
  }
  return out;
}

function evaluateChain(model: ExpressModel, chain: Step[], route: { obj: ExpressObject; index: number; layer: Extract<Layer, { kind: 'route' }> }, method: string): PathResult {
  for (const s of chain) {
    if (s.obj.open) return { ok: false, reason: 'sentinel.express.registrationDynamic', at: [s.obj.open] };
    if (s.obj.matching) return { ok: false, reason: 'sentinel.express.routingSettingUnsupported', at: [s.obj.matching] };
    if (s.obj.subApp) return { ok: false, reason: 'sentinel.express.subAppUnsupported', at: [s.obj.subApp] };
  }
  const mountLayers = chain.slice(0, -1).map(s => s.obj.layers[s.mountIndex!] as Extract<Layer, { kind: 'mount' }>);
  let full: string | undefined = '/';
  for (const m of mountLayers) full = full === undefined ? undefined : joinPaths(full, m.path);
  full = full === undefined ? undefined : joinPaths(full, route.layer.path);
  if (full === undefined || !segments(full)) return { ok: false, reason: 'sentinel.express.pathUnsupported', at: [...mountLayers.map(m => m.at), route.layer.at] };
  const entries: Entry[] = [];
  let template = full;
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i]!;
    const last = i === chain.length - 1;
    simulateLayers(model, s.obj, template, last ? route.index : s.mountIndex!, method, entries, 0);
    if (!last) template = stripPrefix(template, mountLayers[i]!.path)!;
  }
  // The route's own handlers before the last run first, in order.
  const own = route.layer.handlers;
  for (const h of own.slice(0, -1)) pushEffect(model, route.layer.file, h, 'match', entries);
  return { ok: true, entries: resolveErrorPaths(entries), mounts: mountLayers.map(m => m.at) };
}

const signature = (r: PathResult) => r.ok
  ? JSON.stringify(r.entries.map(e => [e.kind, e.kind === 'refusal' ? e.property : e.kind === 'unknown' ? [e.reason, ...e.properties] : '', e.at.map(a => `${a.file.path}:${a.node.start}`)]))
  : `!${r.reason}`;

// ---- the pack ----

/** Control facts for one source's Express routes, validated against `sentinel-controls/draft-1`. */
export async function analyzeExpress(input: ExpressPackInput): Promise<ControlFactsEnvelope> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  await loadParser();
  const mine = input.snapshot.entries.filter(e => e.sourceId === input.sourceId);
  const frontiers: ScopedReason[] = [];
  const frontier = (scope: string, reason: ExpressReason) => {
    if (frontiers.length < 10_000) frontiers.push({ scopeId: `${input.sourceId}:${scope}`, reasonCode: reason });
  };
  // Completeness: a source file capture did not keep, or a folder it did not list, could register another layer.
  let incomplete = false;
  for (const e of mine) {
    if (e.kind === 'directory-boundary' && !SAFE_BOUNDARIES.has(e.reasonCode)) { incomplete = true; frontier(e.relativePath, 'sentinel.express.sourceIncomplete'); }
    if (((e.kind === 'file' && e.disposition !== 'included') || e.kind === 'symlink') && isJsPath(e.relativePath)) { incomplete = true; frontier(e.relativePath, 'sentinel.express.sourceIncomplete'); }
  }
  const included = mine.filter((e): e is Extract<typeof e, { disposition: 'included' }> => e.kind === 'file' && e.disposition === 'included');
  const read: { path: string; content: ArtifactId }[] = [];
  const bytesOf = async (e: { relativePath: string; content: ArtifactId }) => {
    read.push({ path: e.relativePath, content: e.content });
    return Buffer.from(await input.readContent(e.content));
  };
  const jsonAt = async (path: string): Promise<{ doc: JsonDoc; content: ArtifactId } | undefined> => {
    const e = included.find(x => x.relativePath === path);
    if (!e || e.bytes > limits.maxManifestBytes) return undefined;
    const raw = await bytesOf(e);
    const text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) return undefined;
    return { doc: parseJson(text), content: e.content };
  };

  // ---- version scope ----
  const manifest = await jsonAt('package.json');
  const lockEntry = included.find(e => e.relativePath === 'package-lock.json');
  const npmLock = lockEntry ? await jsonAt('package-lock.json') : undefined;
  const otherLockfile = included.some(e => /^(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/.test(e.relativePath));
  let aliased = false;
  for (const e of included) {
    if (!/(^|\/)[jt]sconfig[^/]*\.json$/.test(e.relativePath)) continue;
    const text = (await bytesOf(e)).toString('utf8');
    if (/"paths"/.test(text) && /"express(\/[^"]*)?"\s*:/.test(text)) aliased = true;
  }
  const verdict: VersionVerdict = lockEntry && !npmLock
    ? { ok: false, reason: 'sentinel.express.versionUnresolved', evidence: [] }
    : versionScope(manifest?.doc, npmLock?.doc, otherLockfile, aliased);
  const docs: Record<string, { doc: JsonDoc; content: ArtifactId } | undefined> = { 'package.json': manifest, 'package-lock.json': npmLock };
  const versionEvidence: SourceEvidence[] = verdict.evidence.flatMap(ev => {
    const d = docs[ev.path];
    if (!d) return [];
    return [{ snapshotId: input.snapshot.id, sourceId: input.sourceId, relativePath: ev.path, content: d.content,
      span: { startByte: Buffer.byteLength(d.doc.text.slice(0, ev.node.start)), endByte: Buffer.byteLength(d.doc.text.slice(0, ev.node.end)) } }];
  });
  // A file under a nested package manifest resolves `express` from that package, not the root one.
  const nestedPackages = included.filter(e => /\/package\.json$/.test(e.relativePath)).map(e => e.relativePath.slice(0, -'package.json'.length));
  const underNested = (p: string) => nestedPackages.some(d => p.startsWith(d));

  // ---- parse every captured source file, bounded ----
  const sources = included.filter(e => isJsPath(e.relativePath) && !/(^|\/)node_modules\//.test(e.relativePath))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  const files: JsFile[] = [];
  let budget = limits.maxSourceBytes;
  for (const e of sources) {
    if (files.length >= limits.maxSourceFiles || e.bytes > budget) { incomplete = true; frontier(e.relativePath, 'sentinel.express.scanLimit'); continue; }
    budget -= e.bytes;
    const f = parseJs(e.relativePath, e.content, await bytesOf(e));
    // A file that cannot be read exactly could register a layer this pack does not see.
    if ((f.hasErrors || !f.exact) && /express|\.use\s*\(|Router/.test(f.text)) {
      incomplete = true; frontier(e.relativePath, f.exact ? 'sentinel.express.syntaxError' : 'sentinel.express.sourceNotUtf8');
    }
    files.push(f);
  }
  const model = buildModel(files);
  for (const f of model.frontiers) frontier(f.at.file.path, f.reason);

  const toEvidence = (at: At): SourceEvidence | undefined => {
    const span = at.file.span(at.node);
    return span ? { snapshotId: input.snapshot.id, sourceId: input.sourceId, relativePath: at.file.path, content: at.file.content as ArtifactId, span } : undefined;
  };
  const evidenceOf = (ats: readonly At[]) => ats.map(toEvidence).filter((e): e is SourceEvidence => !!e);
  const facts: ControlFact[] = [];
  const add = (surfaceId: string, property: Property, order: number, verdict: ControlVerdict, evidence: SourceEvidence[], reasonCode?: ExpressReason) => {
    const id = `express.${createHash('sha256').update(`${surfaceId}\u0000${property}\u0000${order}`).digest('hex').slice(0, 40)}`;
    const ev = dedupe(evidence).slice(0, MAX_EVIDENCE);
    facts.push(verdict === 'unknown'
      ? { id, property, surfaceId, order, verdict, evidence: ev, reasonCode: reasonCode ?? 'sentinel.express.versionUnresolved' }
      : { id, property, surfaceId, order, verdict, evidence: ev });
  };
  const unknownBoth = (surfaceId: string, evidence: SourceEvidence[], reason: ExpressReason) => {
    for (const p of PROPERTIES) add(surfaceId, p, 0, 'unknown', evidence, reason);
  };

  // ---- surfaces: the parser's route nodes that are Express registrations ----
  const indexed = new Map(input.analysis.index.nodes.map(n => [n.nodeId, n]));
  const prefix = `${input.sourceId}::route::`;
  const routes = input.analysis.artifact.graph.nodes.filter(n => n.kind === 'route' && n.loc?.repo === input.sourceId && n.id.startsWith(prefix)
    && isJsPath(n.loc.path) && !isTestPath(n.loc.path));
  const fileByPath = new Map(files.map(f => [f.path, f]));
  const allRouteLayers = model.objects.flatMap(o => o.layers.filter((l): l is Extract<Layer, { kind: 'route' }> => l.kind === 'route' && !l.chained));
  for (const node of routes.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const m = /^([A-Z]+) (\S+)$/.exec(node.id.slice(prefix.length));
    if (!m) continue;
    const method = m[1]!.toLowerCase();
    const path = m[2]!;
    const at = indexed.get(node.id);
    const routeEvidence: SourceEvidence[] = at?.byteSpan
      ? [{ snapshotId: input.snapshot.id, sourceId: input.sourceId, relativePath: at.path, content: at.content, span: at.byteSpan, nodeId: node.id }] : [];
    const file = fileByPath.get(node.loc!.path);
    const registered = model.routesAt(node.loc!.path, node.loc!.line).filter(r => r.layer.path === path && r.layer.methods !== 'all' && r.layer.methods.includes(method));
    if (!registered.length) {
      // Not a registration this model holds: decide whether it is an Express route at all.
      const call = file ? registrationCall(file, node.loc!.line, method, path) : undefined;
      if (!call) continue; // another framework's route (a file route, a raw server): not this pack's surface
      if (model.foreignObject(file!, call.object)) continue;
      const root = model.resolveValue(file!, call.object);
      if (!verdict.ok) { unknownBoth(node.id, [...routeEvidence, ...versionEvidence], verdict.reason); continue; }
      const reason: ExpressReason = root.kind === 'object' ? (root.obj.open ? 'sentinel.express.registrationDynamic' : 'sentinel.express.registrationUnsupported') : 'sentinel.express.routeObjectUnresolved';
      unknownBoth(node.id, [...routeEvidence, ...evidenceOf([{ file: file!, node: call.node }])], reason);
      continue;
    }
    const route = registered[0]!;
    const regEvidence = [...routeEvidence, ...evidenceOf([route.layer.at])];
    if (!verdict.ok) { unknownBoth(node.id, [...regEvidence, ...versionEvidence], verdict.reason); continue; }
    if (underNested(node.loc!.path)) { unknownBoth(node.id, regEvidence, 'sentinel.express.versionUnresolved'); continue; }
    if (!at?.byteSpan) { unknownBoth(node.id, regEvidence, 'sentinel.express.routeNotIndexed'); continue; }
    if (!route.layer.file.exact) { unknownBoth(node.id, regEvidence, 'sentinel.express.sourceNotUtf8'); continue; }
    if (incomplete) { unknownBoth(node.id, regEvidence, 'sentinel.express.sourceIncomplete'); continue; }
    // One graph surface stands for every registration of the same method and path; several cannot be told apart.
    const same = allRouteLayers.filter(l => l.path === path && l.methods !== 'all' && l.methods.includes(method));
    if (same.length > 1) { unknownBoth(node.id, [...regEvidence, ...evidenceOf(same.map(l => l.at))], 'sentinel.express.surfaceAmbiguous'); continue; }
    const chains = chainsTo(route.obj);
    if (chains === 'cycle') { unknownBoth(node.id, regEvidence, 'sentinel.express.mountCycle'); continue; }
    if (!chains.length) { unknownBoth(node.id, [...regEvidence, ...evidenceOf([route.obj.at])], 'sentinel.express.routeNotMounted'); continue; }
    const results = chains.map(c => evaluateChain(model, c, route, method));
    const first = results[0]!;
    if (results.some(r => signature(r) !== signature(first))) {
      unknownBoth(node.id, [...regEvidence, ...evidenceOf(results.flatMap(r => (r.ok ? r.mounts : r.at)))], 'sentinel.express.mountsDisagree');
      continue;
    }
    if (!first.ok) { unknownBoth(node.id, [...regEvidence, ...evidenceOf(first.at)], first.reason); continue; }
    const mountEvidence = evidenceOf(results.flatMap(r => (r.ok ? r.mounts : [])));
    const base = [...regEvidence, ...mountEvidence];
    first.entries.forEach((e, order) => {
      if (e.kind === 'refusal') add(node.id, e.property, order, 'applies', [...base, ...evidenceOf(e.at), ...versionEvidence]);
      else if (e.kind === 'unknown') for (const p of e.properties) add(node.id, p, order, 'unknown', [...base, ...evidenceOf(e.at)], e.reason);
    });
    // No layer before the handler refuses for a property, and every one was read: it does not apply.
    for (const p of PROPERTIES) {
      const touched = first.entries.some(e => (e.kind === 'refusal' && e.property === p) || (e.kind === 'unknown' && e.properties.includes(p)));
      if (!touched) add(node.id, p, first.entries.length, 'does-not-apply', [...base, ...evidenceOf(first.entries.flatMap(e => e.at)), ...versionEvidence]);
    }
  }

  const envelope: ControlFactsEnvelope = {
    schema: 'sentinel-controls/draft-1', snapshotId: input.snapshot.id,
    framework: { id: 'express', version: verdict.ok ? EXPRESS_VERSION : null },
    packDigest: digestOf({ pack: EXPRESS_PACK, support: EXPRESS_SUPPORT }),
    environmentDigest: digestOf({ framework: 'express', environment: 'source-only' }),
    registrationDigest: digestOf([...new Map(read.map(r => [r.path, r])).values()].sort((a, b) => (a.path < b.path ? -1 : 1))),
    capability: 'framework-order', facts, frontiers,
  };
  const valid = validateEnvelope('controls', envelope);
  if (!valid.ok) throw new ExpressPackError(`the pack produced an invalid envelope: ${valid.errors[0]?.code} at ${valid.errors[0]?.path}`);
  return valid.value;
}

/** The `<object>.<method>('<path>', …)` call registering a route at a line, as the public parser reads it. */
function registrationCall(file: JsFile, line: number, method: string, path: string): { node: JsNode; object: JsNode } | undefined {
  let found: { node: JsNode; object: JsNode } | undefined;
  let l = 1;
  const lineStarts = [0];
  for (let i = 0; i < file.text.length; i++) if (file.text.charCodeAt(i) === 10) { lineStarts.push(i + 1); l++; }
  void l;
  const lineOf = (offset: number) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= offset) lo = mid; else hi = mid - 1; } return lo + 1; };
  walk(file.program, n => {
    if (found || n.type !== 'CallExpression') return;
    const callee = unwrap(n.callee as JsNode);
    if (callee?.type !== 'MemberExpression' || callee.computed || identifierName(callee.property as JsNode) !== method) return;
    const args = n.arguments as JsNode[];
    if (stringValue(args[0]) !== path || lineOf(n.start) !== line) return;
    found = { node: n, object: callee.object as JsNode };
  });
  return found;
}

function dedupe(evidence: SourceEvidence[]): SourceEvidence[] {
  const seen = new Set<string>();
  return evidence.filter(e => { const k = `${e.relativePath}:${e.span.startByte}:${e.span.endByte}:${e.nodeId ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
