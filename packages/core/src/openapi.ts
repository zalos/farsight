/**
 * OpenAPI / Swagger as a lens over the same graph (docs/proposals/openapi-surface.md).
 *
 * A spec is documentation about HTTP endpoints, so its operations land on the
 * same `route` node ids the code adapters emit and gain a `contract`. This
 * module is the single place that decides what a spec declares
 * (`specOperations`), how that squares with the code (`reconcile` — drift is
 * computed here once, stored on the node at ingest, and re-run on demand for
 * a proposed spec), what a spec generated *from* the code looks like
 * (`graphToSpec` — honest `x-farsight-inferred` markers), and how the APIs
 * surface reads it all back (`apiSurface`, `consumersOf`).
 *
 * Pure functions over parsed objects: YAML/JSON reading lives in
 * `@farsight/parsers` (core stays dependency-free).
 */
import type { GraphNode, GraphFragment, OperationContract, ContractParam, DriftKind, Loc } from './graph.js';
import type { GraphIndex } from './query.js';
import { buildIndex, businessSummary } from './query.js';
import { t } from './strings.js';
import { counted, countedText, breakdownText, type Counted, type CountPart } from './counts.js';
import type { GraphMeta } from './store.js';

// ── the slice of an OpenAPI/Swagger document this module reads ────────────

export interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string; [k: string]: unknown };
  servers?: { url?: string; description?: string }[];
  basePath?: string; // swagger 2
  paths?: Record<string, Record<string, unknown> | undefined>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown>; [k: string]: unknown };
  definitions?: Record<string, unknown>; // swagger 2
  securityDefinitions?: Record<string, unknown>; // swagger 2
  security?: Record<string, string[]>[];
  tags?: { name: string; description?: string }[];
  [k: string]: unknown;
}

/** Where a spec came from — display + deep-link data; `lineOf` is supplied by the reader (YAML ranges / JSON scan). */
export interface SpecSource {
  repo: string;
  /** repo-relative file path, or the URL it was fetched from */
  path: string;
  /** api node name override; defaults to info.title */
  name?: string;
  lineOf?: (path: string, method: string) => number | undefined;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

/** `/invoices/{id}`, `/invoices/:id`, `/invoices/${id}` → `/invoices/:param` (same rule as parsers/shared/tags.ts). */
export function normalizeRoutePath(p: string): string {
  return p
    .replace(/\$\{[^}]*\}/g, ':param')
    .replace(/:[A-Za-z_]+/g, ':param')
    .replace(/\{[^}/]+\}/g, ':param');
}

export function isOpenApiDoc(x: unknown): x is OpenApiDoc {
  if (!x || typeof x !== 'object') return false;
  const d = x as OpenApiDoc;
  const versioned = (typeof d.openapi === 'string' && d.openapi.startsWith('3')) || d.swagger === '2.0';
  return versioned && !!d.paths && typeof d.paths === 'object';
}

/** Follow a local `$ref` (`#/components/schemas/X`) inside the document; anything else comes back as-is. */
export function deref<T = unknown>(doc: OpenApiDoc, x: unknown, depth = 0): T {
  if (!x || typeof x !== 'object' || depth > 8) return x as T;
  const ref = (x as { $ref?: unknown }).$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return x as T;
  let cur: unknown = doc;
  for (const seg of ref.slice(2).split('/')) {
    if (!cur || typeof cur !== 'object') return x as T;
    cur = (cur as Record<string, unknown>)[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return deref<T>(doc, cur, depth + 1);
}

/** Display name of a schema: its `$ref` tail, else its `title`, else a shape word. */
export function schemaName(x: unknown): string | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  if (typeof o.$ref === 'string') return o.$ref.split('/').pop();
  if (typeof o.title === 'string') return o.title;
  if (typeof o.type === 'string') {
    if (o.type === 'array') {
      const item = schemaName(o.items);
      return item ? `${item}[]` : 'array';
    }
    return o.type;
  }
  return undefined;
}

/** Top-level property names of an object schema (after deref), capped. */
function schemaFields(doc: OpenApiDoc, x: unknown): string[] | undefined {
  const s = deref<Record<string, unknown>>(doc, x);
  if (!s || typeof s !== 'object') return undefined;
  const props = s.properties;
  if (props && typeof props === 'object') return Object.keys(props).slice(0, 40);
  if (Array.isArray(s.allOf)) {
    const out = new Set<string>();
    for (const part of s.allOf) for (const f of schemaFields(doc, part) ?? []) out.add(f);
    return out.size ? [...out].slice(0, 40) : undefined;
  }
  return undefined;
}

export interface SpecOperation {
  method: string; // upper-case
  path: string; // as written in the spec
  normPath: string;
  /** `${repo}::route::${METHOD} ${path}` — the id a spec-only route node gets */
  routeId: string;
  contract: Omit<OperationContract, 'status' | 'apiId' | 'drift'>;
}

/** Flatten `paths × methods` into operations with their contract (params merged from the path item, `$ref`s followed, security resolved op → document). */
export function specOperations(doc: OpenApiDoc, source: SpecSource): SpecOperation[] {
  const out: SpecOperation[] = [];
  const isV2 = doc.swagger === '2.0';
  const docSecurity = Array.isArray(doc.security) ? doc.security : undefined;
  for (const [path, item0] of Object.entries(doc.paths ?? {})) {
    const item = deref<Record<string, unknown>>(doc, item0);
    if (!item || typeof item !== 'object') continue;
    const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const m of METHODS) {
      const op = deref<Record<string, unknown>>(doc, item[m]);
      if (!op || typeof op !== 'object') continue;
      const method = m.toUpperCase();
      const rawParams = [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => deref<Record<string, unknown>>(doc, p))
        .filter((p) => p && typeof p === 'object');
      const params: ContractParam[] = [];
      let requestBody: OperationContract['requestBody'];
      for (const p of rawParams) {
        const where = String(p.in ?? '');
        if (isV2 && where === 'body') {
          requestBody = {
            schema: schemaName(p.schema),
            required: p.required === true,
            fields: schemaFields(doc, p.schema),
          };
          continue;
        }
        if (!['path', 'query', 'header', 'cookie'].includes(where)) continue;
        const schema = deref<Record<string, unknown>>(doc, p.schema);
        params.push({
          name: String(p.name ?? ''),
          in: where as ContractParam['in'],
          ...(p.required === true || where === 'path' ? { required: true } : {}),
          ...(typeof (schema?.type ?? p.type) === 'string' ? { type: String(schema?.type ?? p.type) } : {}),
          ...(typeof p.description === 'string' ? { description: p.description } : {}),
        });
      }
      if (!isV2 && op.requestBody) {
        const rb = deref<Record<string, unknown>>(doc, op.requestBody);
        const content = (rb?.content ?? {}) as Record<string, { schema?: unknown }>;
        const [contentType, media] = Object.entries(content)[0] ?? [];
        requestBody = {
          ...(contentType ? { contentType } : {}),
          ...(media?.schema ? { schema: schemaName(media.schema) } : {}),
          ...(rb?.required === true ? { required: true } : {}),
          ...(media?.schema ? { fields: schemaFields(doc, media.schema) } : {}),
        };
        if (requestBody.fields === undefined) delete requestBody.fields;
      }
      const responses: NonNullable<OperationContract['responses']> = [];
      for (const [status, r0] of Object.entries((op.responses ?? {}) as Record<string, unknown>)) {
        const r = deref<Record<string, unknown>>(doc, r0);
        if (!r || typeof r !== 'object') continue;
        let schema: string | undefined;
        if (isV2) schema = schemaName(r.schema);
        else {
          const content = (r.content ?? {}) as Record<string, { schema?: unknown }>;
          const media = Object.values(content)[0];
          schema = media?.schema ? schemaName(media.schema) : undefined;
        }
        responses.push({
          status,
          ...(typeof r.description === 'string' ? { description: r.description } : {}),
          ...(schema ? { schema } : {}),
        });
      }
      const security = flattenSecurity(
        Array.isArray(op.security) ? (op.security as Record<string, string[]>[]) : docSecurity,
      );
      const tags = Array.isArray(op.tags) ? op.tags.map(String) : undefined;
      const line = source.lineOf?.(path, m);
      // x-* extensions verbatim — the consumer's own vocabulary (x-phase, x-internal…) travels with the contract
      const extensions: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op)) if (k.startsWith('x-') && v !== undefined) extensions[k] = v;
      const contract: SpecOperation['contract'] = {
        spec: {
          path: source.path,
          ...(line != null ? { line } : {}),
          ...(typeof op.operationId === 'string' ? { operationId: op.operationId } : {}),
        },
        ...(typeof op.summary === 'string' ? { summary: op.summary.trim() } : {}),
        ...(typeof op.description === 'string' ? { description: op.description.trim() } : {}),
        ...(op.deprecated === true ? { deprecated: true } : {}),
        ...(tags?.length ? { tags } : {}),
        ...(params.length ? { params } : {}),
        ...(requestBody ? { requestBody } : {}),
        ...(responses.length ? { responses } : {}),
        ...(security.length ? { security } : {}),
        ...(Object.keys(extensions).length ? { extensions } : {}),
      };
      out.push({
        method,
        path,
        normPath: normalizeRoutePath(path),
        routeId: `${source.repo}::route::${method} ${path}`,
        contract,
      });
    }
  }
  return out;
}

/**
 * Tags mirrored from scalar `x-*` extensions so they are searchable and
 * filterable: `x-phase: 2` → `phase:2`, `x-internal: true` → `internal`,
 * `x-internal: false` → nothing. Objects/arrays stay on `contract.extensions` only.
 */
export function extensionTags(extensions: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(extensions ?? {})) {
    const name = k.slice(2).toLowerCase();
    if (!name || name.startsWith('farsight-')) continue; // our own generated markers never become tags
    if (v === true) out.push(name);
    else if (typeof v === 'string' || typeof v === 'number') out.push(`${name}:${String(v).trim().toLowerCase()}`);
  }
  return out;
}

/** `[{bearer: []}, {oauth2: ['a','b']}]` → `['bearer', 'oauth2: a b']`; an empty requirement object means "public" and is dropped. */
export function flattenSecurity(reqs: Record<string, string[]>[] | undefined): string[] {
  if (!reqs) return [];
  const out: string[] = [];
  for (const req of reqs) {
    if (!req || typeof req !== 'object') continue;
    for (const [scheme, scopes] of Object.entries(req)) {
      out.push(Array.isArray(scopes) && scopes.length ? `${scheme}: ${scopes.join(' ')}` : scheme);
    }
  }
  return out;
}

/** Base paths the spec's servers add in front of every path (`https://h/v1` → `/v1`); empty for `/`. */
export function specBasePaths(doc: OpenApiDoc): string[] {
  const out = new Set<string>();
  if (typeof doc.basePath === 'string' && doc.basePath !== '/') out.add(doc.basePath.replace(/\/$/, ''));
  for (const s of doc.servers ?? []) {
    if (typeof s?.url !== 'string') continue;
    let p = s.url.replace(/\{[^}]*\}/g, 'x');
    try {
      p = new URL(p, 'http://placeholder').pathname;
    } catch {
      /* relative url: keep */
    }
    p = p.replace(/\/$/, '');
    if (p && p !== '/') out.add(p);
  }
  return [...out];
}

/** Does the document use security at all? (Only then is a guarded route with no declared security a gap worth stating.) */
export function specDeclaresSecurity(doc: OpenApiDoc, ops: SpecOperation[]): boolean {
  if (doc.components?.securitySchemes && Object.keys(doc.components.securitySchemes).length) return true;
  if (doc.securityDefinitions && Object.keys(doc.securityDefinitions).length) return true;
  return ops.some((o) => o.contract.security?.length);
}

export function apiNodeId(repo: string, specPath: string): string {
  return `${repo}::api::${specPath}`;
}

/** The `api` node for one document. */
export function apiNodeOf(doc: OpenApiDoc, source: SpecSource): GraphNode {
  const title = source.name ?? doc.info?.title ?? source.path;
  const version = doc.info?.version;
  const format = doc.swagger === '2.0' ? 'swagger 2.0' : `openapi ${doc.openapi ?? '3'}`;
  const servers = (doc.servers ?? []).map((s) => s.url).filter((u): u is string => typeof u === 'string');
  const sig = [format, version ? `version ${version}` : '', servers.length ? `servers: ${servers.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ');
  const isUrl = /^https?:\/\//.test(source.path);
  return {
    id: apiNodeId(source.repo, source.path),
    kind: 'api',
    name: title,
    tags: ['api'],
    ...(doc.info?.description ? { docs: String(doc.info.description).trim() } : {}),
    signature: sig,
    // a URL source has no file to open; a file source deep-links to line 1
    ...(isUrl ? {} : { loc: { repo: source.repo, path: source.path, line: 1 } }),
    facets: { business: { label: title } },
  };
}

// ── reconcile: spec ↔ code, one function for ingest and for ad-hoc diffs ──

export interface DriftEntry {
  kind: DriftKind;
  message: string;
}

export type ApiDriftCategory = 'missing' | 'undocumented' | 'notes';

export interface ReconcileResult {
  /** Policy classifications never remove evidence from the raw operation lists or counts. */
  policy: {
    phase?: string;
    phaseOrder: string[];
    planned: string[];
    metrics: { planned: Counted; internal: Counted };
    internal: string[];
    counts: Record<ApiDriftCategory, number> & { planned: number; internal: number; drift: number };
  };
  api: { id: string; name: string; version?: string; path: string; basePaths: string[] };
  /** declared and implemented */
  matched: { routeId: string; op: string; matchedBy: 'exact' | 'basePath'; contract: OperationContract; loc?: Loc }[];
  /** declared, no implementation in the indexed code */
  specOnly: { routeId: string; op: string; summary?: string; contract: OperationContract }[];
  /** implemented in a repo this spec covers, not declared */
  codeOnly: { routeId: string; name: string; loc?: Loc; contract: OperationContract }[];
  /** repos the spec was matched against (the ones `codeOnly` is computed for) */
  repos: string[];
  counts: {
    declared: number;
    implemented: number;
    /** When hand-made routes contribute, these disjoint parts sum to implemented. */
    implementedBreakdown?: CountPart[];
    matched: number;
    specOnly: number;
    codeOnly: number;
    mismatched: number;
    drift: number;
  };
  /**
   * Observations that are not drift and never fail `--strict`: a matched operation whose handler is
   * a class method (`OrdersController.approveOrder`, a NestJS or Spring controller) named differently
   * from the spec's `operationId`. Matching is by method and path, so the names are free to differ;
   * teams that name the method after the operation want to hear when one does not. Absent when empty.
   */
  notes?: { routeId: string; op: string; kind: 'operationId-name'; message: string }[];
}

export interface ReconcileOptions {
  /** limit code routes to this repo; omitted = any repo whose routes match (codeOnly then covers every repo with a match) */
  repo?: string;
  /** stamp this api id instead of the one derived from the source path (implied surfaces) */
  apiId?: string;
  /** Current delivery phase; only demonstrably later phases are planned. */
  phase?: string;
  /** Earliest to latest; omitted means first use of x-phase in the document. */
  phaseOrder?: string[];
  /** Exact METHOD /path declarations (parameter spelling is normalized); never globs. */
  internalRoutes?: string[];
  /** Same label-to-function matchers as config.guards, used by x-guards. */
  guardNames?: Record<string, string[]>;
  /** Exact function names or ids of multipart readers, requiring a real calls path. */
  validators?: string[];
}

function routeMethodPath(node: GraphNode): { method: string; path: string } | null {
  const m = node.name.match(/^([A-Z]+) (\S.*)$/);
  return m ? { method: m[1]!, path: m[2]! } : null;
}

function guardsOf(index: GraphIndex, routeId: string): GraphNode[] {
  const guards = new Map<string, GraphNode>();
  const pending = [routeId];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of index.in.get(id) ?? []) {
      const guard = edge.kind === 'guards' && edge.meta?.inactive !== true ? index.byId.get(edge.from) : undefined;
      if (guard) guards.set(guard.id, guard);
    }
    // Config guards are applied after adapters mirror handler gates onto routes. Read
    // their direct handler too, then only proven delegate links, never arbitrary helpers.
    for (const edge of index.out.get(id) ?? []) {
      if (edge.kind === 'calls' && edge.meta?.inactive !== true && (id === routeId || edge.meta?.via === 'delegate')) {
        const handler = index.byId.get(edge.to);
        if (handler?.kind === 'function' && handler.loc?.repo === index.byId.get(routeId)?.loc?.repo)
          pending.push(handler.id);
      }
    }
  }
  return [...guards.values()];
}

function validatorsOf(index: GraphIndex, routeId: string): GraphNode[] {
  return (index.in.get(routeId) ?? [])
    .filter((e) => e.kind === 'validates')
    .map((e) => index.byId.get(e.from))
    .filter((n): n is GraphNode => !!n);
}

/** A configured reader is evidence only for a declared multipart body and an actual call path. */
function multipartReaderReached(op: SpecOperation, routeId: string, index: GraphIndex, readers: string[]): boolean {
  if (op.contract.requestBody?.contentType !== 'multipart/form-data' || !readers.length) return false;
  const seen = new Set([routeId]);
  const pending = [routeId];
  while (pending.length) {
    const id = pending.pop()!;
    for (const edge of index.out.get(id) ?? []) {
      if (edge.kind !== 'calls' || edge.meta?.inactive === true || seen.has(edge.to)) continue;
      seen.add(edge.to);
      const target = index.byId.get(edge.to);
      if (!target || target.loc?.repo !== index.byId.get(routeId)?.loc?.repo) continue;
      if (
        (target.kind === 'function' || target.kind === 'rule') &&
        readers.some((name) => target.id === name || target.name === name)
      )
        return true;
      pending.push(target.id);
    }
  }
  return false;
}

/** Drift between one declared operation and its implemented route. */
export function operationDrift(
  op: SpecOperation,
  route: GraphNode,
  index: GraphIndex,
  specUsesSecurity: boolean,
  opts: ReconcileOptions,
): DriftEntry[] {
  const drift: DriftEntry[] = [];
  const guards = guardsOf(index, route.id);
  const security = op.contract.security ?? [];
  const declaredGuards = Array.isArray(op.contract.extensions?.['x-guards'])
    ? op.contract.extensions['x-guards'].filter((name): name is string => typeof name === 'string')
    : [];
  const matchesGuard = (name: string, guard: GraphNode): boolean => {
    if (guard.id === name || guard.name === name || guard.name.endsWith(`: ${name}`)) return true;
    const hay = `${guard.loc?.path ?? ''} ${guard.name}`.toLowerCase();
    return (opts.guardNames?.[name] ?? []).some(
      (matcher) => !/^[A-Z]+ \//.test(matcher) && hay.includes(matcher.toLowerCase()),
    );
  };
  // a gate declared in farsight.config.json is a statement, not a detection: when it is the
  // only gate on an implemented route, say so — the handler enforces nothing the parser can see
  const declaredOnly = guards.filter((g) => g.tags.includes('declared'));
  if (route.loc && guards.length && declaredOnly.length === guards.length) {
    drift.push({
      kind: 'security-declared-only',
      message: `gate declared in farsight.config.json (${declaredOnly.map((g) => g.name).join(', ')}); no guard detected in the code`,
    });
  }
  const enforced = guards.filter((g) => !g.tags.includes('declared'));
  const missingGuards = declaredGuards.filter((name) => !enforced.some((guard) => matchesGuard(name, guard)));
  if (missingGuards.length)
    drift.push({
      kind: 'security-missing-in-code',
      message: t('api.policy.guardsMissing', 'professional').replace('{names}', missingGuards.join(', ')),
    });
  const uncovered = enforced.filter((guard) => !declaredGuards.some((name) => matchesGuard(name, guard)));
  if (security.length && !guards.length) {
    drift.push({
      kind: 'security-missing-in-code',
      message: `spec requires ${security.join(', ')}; no guard is enforced on the route`,
    });
  } else if (!security.length && uncovered.length && (specUsesSecurity || declaredGuards.length > 0)) {
    // only gates the parser detected count here: a config-declared gate exists precisely because the spec cannot state it
    drift.push({
      kind: 'security-missing-in-spec',
      message: t('api.policy.guardsUndeclared', 'professional').replace(
        '{names}',
        uncovered.map((g) => g.name).join(', '),
      ),
    });
  } else if (security.length && guards.length) {
    // scope-level check: every scope the spec names should be mentioned by some guard
    const scopes = security.flatMap((s) => s.split(': ')[1]?.split(' ') ?? []);
    const guardText = guards.map((g) => g.name).join(' ');
    const missing = scopes.filter((s) => !guardText.includes(s));
    if (scopes.length && missing.length) {
      drift.push({
        kind: 'security-mismatch',
        message: `spec requires ${missing.join(', ')}; code enforces ${guards.map((g) => g.name).join(', ')}`,
      });
    }
  }
  if (op.contract.deprecated && !route.tags.includes('deprecated')) {
    drift.push({
      kind: 'deprecated-in-spec-only',
      message: 'spec marks this operation deprecated; the code carries no deprecated tag',
    });
  }
  const validators = validatorsOf(index, route.id);
  // methods that carry no request body: a zod parse there validates the query or the path
  // params, so it is never evidence of an undeclared body
  const bodiless = ['GET', 'HEAD', 'DELETE'].includes(op.method);
  if (validators.length && !op.contract.requestBody && !bodiless) {
    drift.push({
      kind: 'body-undeclared',
      message: `code validates the request body with ${validators.map((v) => v.name).join(', ')}; the spec declares no request body`,
    });
  } else if (
    op.contract.requestBody?.required &&
    !validators.length &&
    !bodiless &&
    !multipartReaderReached(op, route.id, index, opts.validators ?? [])
  ) {
    drift.push({
      kind: 'body-unvalidated',
      message: `spec requires a ${op.contract.requestBody.schema ?? 'request'} body; no validation rule is attached to the route`,
    });
  }
  return drift;
}

/**
 * The class method a route hands its request to — `OrdersController.approveOrder` — when the route's
 * handler is one (a `calls` edge from the route to a function named `Class.method`); undefined for an
 * App Router verb export, an Express handler or an inline body.
 */
function controllerMethodOf(index: GraphIndex, routeId: string): string | undefined {
  for (const e of index.out.get(routeId) ?? []) {
    if (e.kind !== 'calls') continue;
    const fn = index.byId.get(e.to);
    if (fn?.kind === 'function' && /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(fn.name)) return fn.name;
  }
  return undefined;
}

/**
 * Square a spec with the indexed code. Matching is method + normalized path
 * (`{id}` · `:id` → `:param`), exact first, then with each server base path
 * added or removed (reported as `basePath`); never fuzzier than that.
 */
export function reconcile(
  doc: OpenApiDoc,
  index: GraphIndex,
  source: SpecSource,
  opts: ReconcileOptions = {},
): ReconcileResult {
  const ops = specOperations(doc, source);
  const basePaths = specBasePaths(doc);
  const apiId = opts.apiId ?? apiNodeId(source.repo, source.path);
  const specUsesSecurity = specDeclaresSecurity(doc, ops);

  // Source locations and hand-made declarations are code-side; spec-only routes are neither.
  const codeRoutes: { node: GraphNode; key: string; repo: string }[] = [];
  for (const n of index.byId.values()) {
    if (
      n.kind !== 'route' ||
      (!n.loc &&
        (!n.tags.includes('declared') || n.contract?.status === 'declared' || n.contract?.status === 'spec-only'))
    )
      continue;
    const repo = n.loc?.repo ?? n.id.split('::')[0]!;
    if (opts.repo && repo !== opts.repo) continue;
    const mp = routeMethodPath(n);
    if (!mp) continue;
    codeRoutes.push({ node: n, key: `${mp.method} ${normalizeRoutePath(mp.path)}`, repo });
  }
  const byKey = new Map<string, GraphNode[]>();
  for (const r of codeRoutes) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r.node]);

  const matched: ReconcileResult['matched'] = [];
  const specOnly: ReconcileResult['specOnly'] = [];
  const notes: NonNullable<ReconcileResult['notes']> = [];
  const claimed = new Set<string>();
  const reposHit = new Set<string>();
  let mismatched = 0;
  let driftTotal = 0;

  for (const op of ops) {
    let hit: GraphNode | undefined;
    let matchedBy: 'exact' | 'basePath' = 'exact';
    const exact = byKey.get(`${op.method} ${op.normPath}`);
    if (exact?.length) hit = exact.find((n) => !claimed.has(n.id)) ?? exact[0];
    if (!hit) {
      for (const base of basePaths) {
        const withBase = byKey.get(`${op.method} ${normalizeRoutePath(base + op.path)}`);
        const stripped = op.path.startsWith(base + '/')
          ? byKey.get(`${op.method} ${normalizeRoutePath(op.path.slice(base.length))}`)
          : undefined;
        const cand = withBase ?? stripped;
        if (cand?.length) {
          hit = cand.find((n) => !claimed.has(n.id)) ?? cand[0];
          matchedBy = 'basePath';
          break;
        }
      }
    }
    if (hit) {
      claimed.add(hit.id);
      reposHit.add(hit.loc?.repo ?? hit.id.split('::')[0]!);
      const drift = operationDrift(op, hit, index, specUsesSecurity, opts);
      if (drift.length) mismatched++;
      driftTotal += drift.length;
      const contract: OperationContract = {
        status: 'both',
        apiId,
        ...op.contract,
        ...(basePaths.length ? { servers: basePaths } : {}),
        ...(drift.length ? { drift } : {}),
      };
      matched.push({ routeId: hit.id, op: `${op.method} ${op.path}`, matchedBy, contract, loc: hit.loc });
      // the controller method behind the route (`Class.method`) against the spec's operationId — a note, not drift
      const operationId = op.contract.spec?.operationId;
      const method = operationId ? controllerMethodOf(index, hit.id) : undefined;
      if (operationId && method && method.split('.').pop() !== operationId) {
        notes.push({
          routeId: hit.id,
          op: `${op.method} ${op.path}`,
          kind: 'operationId-name',
          message: `the handler is ${method}; the spec names the operation ${operationId}`,
        });
      }
    } else {
      const drift: DriftEntry[] = [
        { kind: 'spec-only', message: 'declared in the spec; no implementation found in the indexed code' },
      ];
      driftTotal++;
      const contract: OperationContract = {
        status: 'spec-only',
        apiId,
        ...op.contract,
        ...(basePaths.length ? { servers: basePaths } : {}),
        drift,
      };
      specOnly.push({
        routeId: op.routeId,
        op: `${op.method} ${op.path}`,
        ...(op.contract.summary ? { summary: op.contract.summary } : {}),
        contract,
      });
    }
  }

  // code-only: implemented routes in the repos this spec demonstrably covers
  const repos = opts.repo ? [opts.repo] : [...reposHit];
  const codeOnly: ReconcileResult['codeOnly'] = [];
  for (const r of codeRoutes) {
    if (claimed.has(r.node.id) || !repos.includes(r.repo)) continue;
    const drift: DriftEntry[] = [
      {
        kind: 'code-only',
        message: r.node.tags.includes('declared')
          ? t('api.declared.codeOnly', 'professional')
          : 'implemented in the code; not declared in the spec',
      },
    ];
    driftTotal++;
    codeOnly.push({
      routeId: r.node.id,
      name: r.node.name,
      loc: r.node.loc,
      contract: { status: 'code-only', apiId, drift },
    });
  }

  const phaseOrder = opts.phaseOrder ?? [
    ...new Set(
      ops.flatMap((op) => {
        const phase = op.contract.extensions?.['x-phase'];
        return typeof phase === 'string' ? [phase] : [];
      }),
    ),
  ];
  const current = opts.phase ? phaseOrder.indexOf(opts.phase) : -1;
  const planned = specOnly
    .filter((op) => {
      const phase = op.contract.extensions?.['x-phase'];
      return current >= 0 && typeof phase === 'string' && phaseOrder.indexOf(phase) > current;
    })
    .map((op) => op.routeId);
  const internalKeys = new Set(
    (opts.internalRoutes ?? []).map((name) => {
      const mp = name.match(/^([A-Z]+) (\/.*)$/);
      return mp ? `${mp[1]} ${normalizeRoutePath(mp[2]!)}` : '';
    }),
  );
  const internal = codeOnly
    .filter((op) => {
      const mp = op.name.match(/^([A-Z]+) (\/.*)$/);
      return !!mp && internalKeys.has(`${mp[1]} ${normalizeRoutePath(mp[2]!)}`);
    })
    .map((op) => op.routeId);
  const missing = specOnly.length - planned.length;
  const undocumented = codeOnly.length - internal.length;
  const policyNotes = driftTotal - specOnly.length - codeOnly.length;
  return {
    policy: {
      ...(opts.phase ? { phase: opts.phase } : {}),
      phaseOrder,
      planned,
      internal,
      metrics: {
        planned: counted(
          planned.length,
          'apis.count.operations',
          'surf.scope.api',
          'reconcile: specOnly with a demonstrably later x-phase',
        ),
        internal: counted(
          internal.length,
          'apis.count.operations',
          'surf.scope.api',
          'reconcile: codeOnly matching internalRoutes',
        ),
      },
      counts: {
        missing,
        undocumented,
        notes: policyNotes,
        planned: planned.length,
        internal: internal.length,
        drift: missing + undocumented + policyNotes,
      },
    },
    api: {
      id: apiId,
      name: source.name ?? doc.info?.title ?? source.path,
      ...(doc.info?.version ? { version: String(doc.info.version) } : {}),
      path: source.path,
      basePaths,
    },
    matched,
    specOnly,
    codeOnly,
    repos,
    ...(notes.length ? { notes } : {}),
    counts: {
      declared: ops.length,
      implemented: codeRoutes.filter((r) => repos.includes(r.repo)).length,
      ...implementedBreakdown(
        codeRoutes.filter((r) => repos.includes(r.repo)).map((r) => r.node.tags.includes('declared')),
      ),
      matched: matched.length,
      specOnly: specOnly.length,
      codeOnly: codeOnly.length,
      mismatched,
      drift: driftTotal,
    },
  };
}

/**
 * Ingest-time application: reconcile and write the result into the fragment —
 * matched routes gain their contract, spec-only routes are added as nodes
 * (declared, not implemented: no `loc`), code-only routes are stamped, and
 * the `api` node with its `contains` edges is added. Mutates in place.
 */
export function applySpecToFragment(
  fragment: GraphFragment,
  doc: OpenApiDoc,
  source: SpecSource,
  opts: ReconcileOptions = {},
): ReconcileResult {
  const index = buildIndex(fragment.nodes, fragment.edges);
  const result = reconcile(doc, index, source, { ...opts, repo: fragment.repo });
  const api = apiNodeOf(doc, source);
  const byId = new Map(fragment.nodes.map((n) => [n.id, n]));
  if (!byId.has(api.id)) {
    fragment.nodes.push(api);
    byId.set(api.id, api);
  }
  let seq = fragment.edges.length;
  const contains = (to: string) => {
    fragment.edges.push({
      id: `e${seq++}`,
      kind: 'contains',
      from: api.id,
      to,
      resolution: { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' },
    });
  };
  for (const m of result.matched) {
    const node = byId.get(m.routeId)!;
    node.contract = m.contract;
    if (m.contract.tags)
      for (const tg of m.contract.tags) {
        const t = `api:${tg.toLowerCase()}`;
        if (!node.tags.includes(t)) node.tags.push(t);
      }
    if (m.contract.deprecated && !node.tags.includes('deprecated')) node.tags.push('deprecated');
    for (const t of extensionTags(m.contract.extensions)) if (!node.tags.includes(t)) node.tags.push(t);
    contains(node.id);
  }
  for (const s of result.specOnly) {
    if (byId.has(s.routeId)) continue;
    const node: GraphNode = {
      id: s.routeId,
      kind: 'route',
      name: s.op,
      lang: 'openapi',
      tags: [
        'spec-only',
        ...(s.contract.tags ?? []).map((tg) => `api:${tg.toLowerCase()}`),
        ...(s.contract.deprecated ? ['deprecated'] : []),
        ...extensionTags(s.contract.extensions),
      ],
      ...(s.contract.description ? { docs: s.contract.description } : {}),
      contract: s.contract,
    };
    fragment.nodes.push(node);
    byId.set(node.id, node);
    contains(node.id);
  }
  for (const c of result.codeOnly) {
    const node = byId.get(c.routeId)!;
    node.contract = c.contract;
    if (!node.tags.includes('undocumented')) node.tags.push('undocumented');
    contains(node.id);
  }
  return result;
}

/** A spec with no code at all (a URL or a lone file as a source): api node + declared routes. */
export function specToFragment(doc: OpenApiDoc, source: SpecSource): GraphFragment {
  const fragment: GraphFragment = { repo: source.repo, nodes: [], edges: [], meta: { files: 1, sourceHash: 'spec' } };
  applySpecToFragment(fragment, doc, source);
  // no code in this source: "not implemented" would be a gap that cannot exist — the operations are simply declared
  for (const n of fragment.nodes) {
    if (n.kind !== 'route' || !n.contract) continue;
    n.contract.status = 'declared';
    delete n.contract.drift;
    n.tags = n.tags.map((t) => (t === 'spec-only' ? 'declared' : t));
  }
  return fragment;
}

// ── generate: code → spec, with every inference marked ────────────────────

/** Property names from a zod object literal or a Java DTO body, best effort; undefined when nothing parsable. */
export function fieldsFromSource(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  const out: string[] = [];
  const zi = text.indexOf('z.object(');
  if (zi >= 0) {
    const start = text.indexOf('{', zi);
    let depth = 0;
    let i = start;
    let seg = '';
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '{' || ch === '(' || ch === '[') {
        depth++;
        if (depth === 1) {
          seg = '';
          continue;
        }
      }
      if (ch === '}' || ch === ')' || ch === ']') {
        depth--;
        if (depth === 0) break;
      }
      if (depth === 1) {
        if (ch === ',') {
          seg = '';
          continue;
        }
        seg += ch;
        const m = seg.match(/^\s*([A-Za-z_$][\w$]*)\s*:$/);
        if (m) {
          out.push(m[1]!);
          seg = '';
        }
      }
    }
  } else {
    for (const m of text.matchAll(/(?:private|public|protected)\s+[\w<>[\], ]+\s+(\w+)\s*[;=]/g)) out.push(m[1]!);
  }
  return out.length ? [...new Set(out)].slice(0, 40) : undefined;
}

export interface GenerateOptions {
  repo: string;
  /** graph identity for `info.x-farsight` provenance */
  meta?: GraphMeta;
  title?: string;
}

/**
 * OpenAPI 3.1 document from the implemented routes of one repo. Everything
 * the graph could not see is marked `x-farsight-inferred`; every operation
 * carries `x-farsight-source` (file:line) and `x-farsight-node` (graph id) so
 * the generated file links back. Round trip is a test: generate → reconcile
 * against the same graph → zero drift.
 */
export function graphToSpec(index: GraphIndex, opts: GenerateOptions): OpenApiDoc {
  const routes = [...index.byId.values()]
    .filter((n) => n.kind === 'route' && n.loc?.repo === opts.repo && routeMethodPath(n))
    .sort((a, b) => a.name.localeCompare(b.name));
  const existingApi = [...index.byId.values()].find((n) => n.kind === 'api' && n.loc?.repo === opts.repo);
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  const securitySchemes: Record<string, unknown> = {};
  const tagSet = new Set<string>();
  const specTags = new Set(routes.flatMap((r) => r.contract?.tags ?? []));
  const tagFor = (seg: string) => [...specTags].find((t) => t.toLowerCase() === seg.toLowerCase()) ?? seg;

  for (const route of routes) {
    const { method, path } = routeMethodPath(route)!;
    // express `:id` → `{id}`; anonymous `:param` (App Router) → `{param}`, `{param2}` …
    let anon = 0;
    const oasPath = path
      .replace(/\$\{[^}]*\}/g, () => `{param${++anon > 1 ? anon : ''}}`)
      .replace(/:([A-Za-z_]+)/g, (_m, name: string) => {
        if (name !== 'param') return `{${name}}`;
        anon++;
        return `{param${anon > 1 ? anon : ''}}`;
      });
    const inferred: string[] = [];
    const op: Record<string, unknown> = {};
    const c = route.contract;

    op.operationId = c?.spec?.operationId ?? operationIdOf(method, oasPath);
    // summary: authored @business / docs / spec summary on the route, else the handler's own summary,
    // else — when the handler only hands its body on (`via: 'delegate'`, a controller method) — the
    // summary of the function it hands it to
    let summary = businessSummary(route);
    if (!summary) {
      const callee = (index.out.get(route.id) ?? [])
        .filter((e) => e.kind === 'calls')
        .map((e) => index.byId.get(e.to))
        .find((n) => n && n.kind === 'function');
      if (callee) summary = businessSummary(callee);
      if (!summary && callee) {
        const delegate = (index.out.get(callee.id) ?? [])
          .filter((e) => e.kind === 'calls' && e.meta?.via === 'delegate')
          .map((e) => index.byId.get(e.to))
          .find((n) => n && n.kind === 'function');
        if (delegate) summary = businessSummary(delegate);
      }
    }
    if (summary) op.summary = summary;
    if (c?.description) op.description = c.description;
    if (route.tags.includes('deprecated')) op.deprecated = true;
    // tag: the spec's own, else the group, else the first meaningful path segment (skipping api/v1-style prefixes)
    const seg = oasPath.split('/').filter((s) => s && !s.startsWith('{') && !/^(api|v\d+)$/i.test(s))[0];
    const tags = c?.tags?.length ? c.tags : [tagFor(route.group ?? seg ?? 'default')];
    op.tags = tags;
    tags.forEach((t) => tagSet.add(t));

    const params: Record<string, unknown>[] = [];
    for (const m of oasPath.matchAll(/\{([^}]+)\}/g)) {
      const declared = c?.params?.find((p) => p.in === 'path' && p.name === m[1]);
      params.push({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: declared?.type ?? 'string' },
        ...(declared?.description ? { description: declared.description } : {}),
      });
    }
    for (const p of c?.params ?? []) {
      if (p.in === 'path') continue;
      params.push({
        name: p.name,
        in: p.in,
        ...(p.required ? { required: true } : {}),
        schema: { type: p.type ?? 'string' },
        ...(p.description ? { description: p.description } : {}),
      });
    }
    if (params.length) op.parameters = params;

    const validators = validatorsOf(index, route.id);
    if (validators.length) {
      const v = validators[0]!;
      const fields = fieldsFromSource(v.snippet ?? v.signature);
      schemas[v.name] = {
        type: 'object',
        ...(fields
          ? { properties: Object.fromEntries(fields.map((f) => [f, {}])) }
          : { description: 'shape not extracted — see the source' }),
        ...(v.loc ? { 'x-farsight-source': `${v.loc.path}:${v.loc.line}` } : {}),
        'x-farsight-node': v.id,
      };
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${v.name}` } } },
      };
    } else if (c?.requestBody) {
      op.requestBody = {
        ...(c.requestBody.required ? { required: true } : {}),
        content: {
          [c.requestBody.contentType ?? 'application/json']: {
            schema: c.requestBody.schema ? schemaRef(c.requestBody.schema) : {},
          },
        },
      };
      const bodyName = c.requestBody.schema?.replace(/\[\]$/, '');
      if (bodyName && schemaRef(bodyName).$ref && !schemas[bodyName])
        schemas[bodyName] = {
          type: 'object',
          ...(c.requestBody.fields ? { properties: Object.fromEntries(c.requestBody.fields.map((f) => [f, {}])) } : {}),
        };
    }

    const guards = guardsOf(index, route.id);
    if (guards.length) {
      const req: Record<string, string[]> = {};
      for (const g of guards) {
        const [scheme, scope] = g.name.includes(': ') ? g.name.split(': ', 2) : [g.name, undefined];
        const name = scheme!.replace(/[^\w.-]/g, '_');
        securitySchemes[name] = {
          type: 'http',
          scheme: 'bearer',
          description: `inferred from guard ${scheme}`,
          'x-farsight-inferred': ['type', 'scheme'],
          ...(g.loc ? { 'x-farsight-source': `${g.loc.path}:${g.loc.line}` } : {}),
        };
        req[name] = [...(req[name] ?? []), ...(scope ? [scope] : [])];
      }
      op.security = [req];
    } else if (c?.security?.length) {
      op.security = c.security.map((s) => {
        const [scheme, scopes] = s.split(': ');
        return { [scheme!]: scopes ? scopes.split(' ') : [] };
      });
      for (const s of c.security) {
        const scheme = s.split(': ')[0]!;
        if (!securitySchemes[scheme])
          securitySchemes[scheme] = { type: 'http', scheme: 'bearer', 'x-farsight-inferred': ['type', 'scheme'] };
      }
    }

    if (c?.responses?.length) {
      op.responses = Object.fromEntries(
        c.responses.map((r) => [
          r.status,
          {
            description: r.description ?? '',
            ...(r.schema ? { content: { 'application/json': { schema: schemaRef(r.schema) } } } : {}),
          },
        ]),
      );
      for (const r of c.responses) {
        const name = r.schema?.replace(/\[\]$/, '');
        if (name && schemaRef(name).$ref && !schemas[name])
          schemas[name] = {
            type: 'object',
            description: 'declared in the existing spec; fields not carried into the graph',
          };
      }
    } else {
      const status = route.snippet?.match(/\.status\((\d{3})\)/)?.[1] ?? (method === 'POST' ? '201' : '200');
      op.responses = { [status]: { description: status === '201' ? 'Created' : 'OK' } };
      inferred.push('responses');
    }
    if (route.loc) op['x-farsight-source'] = `${route.loc.path}:${route.loc.line}`;
    op['x-farsight-node'] = route.id;
    if (inferred.length) op['x-farsight-inferred'] = inferred;
    (paths[oasPath] ??= {})[method.toLowerCase()] = op;
  }

  const doc: OpenApiDoc = {
    openapi: '3.1.0',
    info: {
      title: opts.title ?? existingApi?.name ?? `${opts.repo} API`,
      version: existingApi?.signature?.match(/version (\S+)/)?.[1] ?? '0.0.0',
      description: `Generated by Farsight from the implemented routes of ${opts.repo}. Fields marked x-farsight-inferred were not visible to the parser.`,
      'x-farsight': {
        repo: opts.repo,
        generatedAt: new Date().toISOString(),
        ...(opts.meta?.sync != null ? { sync: opts.meta.sync } : {}),
        ...(opts.meta?.commit ? { commit: opts.meta.commit } : {}),
        ...(opts.meta?.tz ? { tz: opts.meta.tz } : {}),
        ...(opts.meta?.digest ? { digest: opts.meta.digest } : {}),
      },
    },
    ...(tagSet.size ? { tags: [...tagSet].sort().map((name) => ({ name })) } : {}),
    paths,
    components: {
      ...(Object.keys(schemas).length ? { schemas } : {}),
      ...(Object.keys(securitySchemes).length ? { securitySchemes } : {}),
    },
  };
  return doc;
}

/** `Invoice` → `$ref`; `Invoice[]` → array of `$ref`; a bare type word → `{type}`. */
function schemaRef(name: string): Record<string, unknown> {
  if (name.endsWith('[]')) return { type: 'array', items: schemaRef(name.slice(0, -2)) };
  if (['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(name)) return { type: name };
  return { $ref: `#/components/schemas/${name}` };
}

function operationIdOf(method: string, oasPath: string): string {
  const segs = oasPath
    .split('/')
    .filter(Boolean)
    .map((s) =>
      s.startsWith('{')
        ? 'By' + cap(s.slice(1, -1))
        : cap(
            s
              .replace(/[^\w]+/g, ' ')
              .trim()
              .split(' ')
              .map(cap)
              .join(''),
          ),
    );
  return method.toLowerCase() + segs.join('');
}
function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// ── the APIs surface: what the viewer, CLI and MCP list ───────────────────

export interface Consumer {
  callerId: string;
  caller: GraphNode;
  /** call-site line in the caller's file (edge meta.line) */
  line?: number;
  crossRepo: boolean;
  confidence?: string;
  /** pages/components upstream of the caller (bounded walk over calls/renders) */
  screens: GraphNode[];
}

/** Who calls this route: every inbound `http` edge, with the screens that reach the caller. */
export function consumersOf(index: GraphIndex, routeId: string): Consumer[] {
  const route = index.byId.get(routeId);
  if (!route) return [];
  const repo = route.loc?.repo ?? routeId.split('::')[0];
  const out: Consumer[] = [];
  for (const e of index.in.get(routeId) ?? []) {
    if (e.kind !== 'http') continue;
    const caller = index.byId.get(e.from);
    if (!caller) continue;
    const callerRepo = caller.loc?.repo ?? caller.id.split('::')[0];
    out.push({
      callerId: caller.id,
      caller,
      ...(typeof e.meta?.line === 'number' ? { line: e.meta.line } : {}),
      crossRepo: callerRepo !== repo,
      ...(e.resolution ? { confidence: e.resolution.confidence } : {}),
      screens: screensUpstream(index, caller.id),
    });
  }
  return out.sort((a, b) => a.caller.name.localeCompare(b.caller.name));
}

function screensUpstream(index: GraphIndex, fromId: string, cap = 6): GraphNode[] {
  const seen = new Set<string>([fromId]);
  const screens: GraphNode[] = [];
  let frontier = [fromId];
  for (let depth = 0; depth < 4 && frontier.length && screens.length < cap; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of index.in.get(id) ?? []) {
        if (e.kind !== 'calls' && e.kind !== 'renders') continue;
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        const n = index.byId.get(e.from);
        if (!n) continue;
        if (n.kind === 'page' || n.kind === 'component') {
          screens.push(n);
          if (screens.length >= cap) break;
        }
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return screens;
}

export interface OperationRow {
  routeId: string;
  /** True only when configuration created this route; attachment to a reader route keeps reader evidence. */
  declaredByPerson?: true;
  name: string;
  method: string;
  path: string;
  /** contract status, or `implemented` for a route with no contract at all (its repo has no spec — not a gap in this route) */
  status: OperationContract['status'] | 'implemented';
  summary?: string;
  deprecated?: boolean;
  tags: string[];
  gates: string[];
  consumers: number;
  drift: DriftEntry[];
  loc?: Loc;
  specLine?: number;
}

export interface ApiSurface {
  id: string;
  name: string;
  repo: string;
  /** spec = backed by a document; implied = routes exist, no spec on file */
  kind: 'spec' | 'implied';
  specPath?: string;
  version?: string;
  description?: string;
  signature?: string;
  operations: OperationRow[];
  /** true when the surface is a spec-only source: no code in it to compare against, so `notImplemented` is not a gap */
  specSource?: boolean;
  /**
   * One vocabulary, three consumers (APIs tab, CLI `api list`, MCP):
   * declared = every operation the spec names (whatever its status) ·
   * implemented = found in code or declared by a person (see the breakdown) · notImplemented = spec only ·
   * undocumented = code, not in the spec.
   */
  counts: {
    operations: number;
    implemented: number;
    /** When hand-made routes contribute, these disjoint parts sum to implemented. */
    implementedBreakdown?: CountPart[];
    declared: number;
    notImplemented: number;
    undocumented: number;
    consumers: number;
    drift: number;
    gated: number;
  };
}

function operationRow(index: GraphIndex, n: GraphNode): OperationRow | null {
  const mp = routeMethodPath(n);
  if (!mp) return null;
  const c = n.contract;
  const gates = guardsOf(index, n.id).map((g) => g.name);
  const consumers = (index.in.get(n.id) ?? []).filter((e) => e.kind === 'http').length;
  return {
    routeId: n.id,
    name: n.name,
    method: mp.method,
    path: mp.path,
    status: c?.status ?? (n.loc || n.tags.includes('declared') ? 'implemented' : 'declared'),
    ...(n.tags.includes('declared') ? { declaredByPerson: true as const } : {}),
    ...(businessSummary(n) ? { summary: businessSummary(n) } : {}),
    ...(c?.deprecated || n.tags.includes('deprecated') ? { deprecated: true } : {}),
    tags: c?.tags ?? [],
    gates,
    consumers,
    drift: c?.drift ?? [],
    ...(n.loc ? { loc: n.loc } : {}),
    ...(c?.spec?.line != null ? { specLine: c.spec.line } : {}),
  };
}

function implementedBreakdown(declared: boolean[]): { implementedBreakdown?: CountPart[] } {
  const people = declared.filter(Boolean).length;
  return people
    ? {
        implementedBreakdown: [
          { n: declared.length - people, key: 'count.part.apiFoundInCode' },
          { n: people, key: 'count.part.apiDeclaredByPerson' },
        ],
      }
    : {};
}

function surfaceCounts(ops: OperationRow[]): ApiSurface['counts'] {
  const supplied = ops.filter((o) => o.status === 'both' || o.status === 'code-only' || o.status === 'implemented');
  return {
    operations: ops.length,
    implemented: supplied.length,
    ...implementedBreakdown(supplied.map((o) => !!o.declaredByPerson)),
    declared: ops.filter((o) => o.status === 'both' || o.status === 'spec-only' || o.status === 'declared').length,
    notImplemented: ops.filter((o) => o.status === 'spec-only' || o.status === 'declared').length,
    undocumented: ops.filter((o) => o.status === 'code-only').length,
    consumers: ops.reduce((s, o) => s + o.consumers, 0),
    drift: ops.reduce((s, o) => s + o.drift.length, 0),
    gated: ops.filter((o) => o.gates.length).length,
  };
}

/**
 * Every API surface in scope: one per `api` node (spec-backed), plus an
 * implied surface per repo that serves routes without any spec — computed,
 * not persisted (the graph records evidence; the lens draws the fog).
 */
export function apiSurface(index: GraphIndex, scope?: Set<string> | null): ApiSurface[] {
  const inScope = (repo: string) => !scope || scope.has(repo);
  const out: ApiSurface[] = [];
  const claimed = new Set<string>();
  for (const n of index.byId.values()) {
    if (n.kind !== 'api') continue;
    const repo = n.loc?.repo ?? n.id.split('::')[0]!;
    if (!inScope(repo)) continue;
    const ops = (index.out.get(n.id) ?? [])
      .filter((e) => e.kind === 'contains')
      .map((e) => index.byId.get(e.to))
      .filter((r): r is GraphNode => !!r && r.kind === 'route')
      .map((r) => {
        claimed.add(r.id);
        return operationRow(index, r);
      })
      .filter((r): r is OperationRow => !!r)
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    out.push({
      id: n.id,
      name: n.name,
      repo,
      kind: 'spec',
      specPath: n.id.slice(`${repo}::api::`.length),
      ...(n.signature?.match(/version (\S+)/)?.[1] ? { version: n.signature.match(/version (\S+)/)![1] } : {}),
      ...(n.docs ? { description: n.docs } : {}),
      ...(n.signature ? { signature: n.signature } : {}),
      operations: ops,
      ...(ops.length && ops.every((o) => o.status === 'declared') ? { specSource: true } : {}),
      counts: surfaceCounts(ops),
    });
  }
  const byRepo = new Map<string, OperationRow[]>();
  for (const n of index.byId.values()) {
    if (n.kind !== 'route' || claimed.has(n.id) || (!n.loc && !n.tags.includes('declared'))) continue;
    const repo = n.loc?.repo ?? n.id.split('::')[0]!;
    if (!inScope(repo)) continue;
    const row = operationRow(index, n);
    if (row) byRepo.set(repo, [...(byRepo.get(repo) ?? []), row]);
  }
  for (const [repo, ops] of byRepo) {
    ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    out.push({
      id: `${repo}::api::implemented`,
      name: `${repo} — no spec on file`,
      repo,
      kind: 'implied',
      operations: ops,
      counts: surfaceCounts(ops),
    });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
}

/** The supplied-operation count, with code and person evidence kept separate. */
export function apiImplementedCount(counts: ApiSurface['counts']): Counted {
  return counted(
    counts.implemented,
    counts.implementedBreakdown ? 'state.unit.operationsSupplied' : 'state.unit.operations',
    'surf.scope.api',
    'apiSurface().counts.implemented / .operations',
    {
      of: counts.operations,
      breakdown: counts.implementedBreakdown,
      recheck: { cli: 'farsight api list', mcp: 'api_surface' },
    },
  );
}

/** Markdown rendering of a reconcile report (CLI `api diff --format md`, MCP). */
export function driftMarkdown(r: ReconcileResult): string {
  const lines = [
    `# API drift — ${r.api.name}${r.api.version ? ` v${r.api.version}` : ''} (${r.api.path})`,
    `declared ${r.counts.declared} · ${r.counts.implementedBreakdown ? t('api.supplied', 'professional') : 'implemented'} ${r.counts.implemented} · matched ${r.counts.matched} · not implemented ${r.policy.counts.missing} · ${t('api.policy.planned', 'professional')} ${r.policy.counts.planned} · undocumented ${r.policy.counts.undocumented} · ${t('api.policy.internal', 'professional')} ${r.policy.counts.internal} · mismatched ${r.counts.mismatched}`,
    t('api.policy.raw', 'professional')
      .replace('{missing}', String(r.counts.specOnly))
      .replace('{undocumented}', String(r.counts.codeOnly))
      .replace('{drift}', String(r.counts.drift)),
    r.repos.length ? `repos: ${r.repos.join(', ')}` : 'repos: (no route in the graph matched this spec)',
    '',
  ];
  if (r.counts.implementedBreakdown) {
    const supplied = apiImplementedCount({
      ...r.counts,
      operations: r.counts.implemented + r.counts.specOnly,
      notImplemented: r.counts.specOnly,
      undocumented: r.counts.codeOnly,
      consumers: 0,
      gated: 0,
    });
    lines.push(`${countedText(supplied, { scope: false })}: ${breakdownText(supplied)}`, '');
  }
  const missing = r.specOnly.filter((op) => !r.policy.planned.includes(op.routeId));
  if (r.policy.planned.length) {
    lines.push(`## ${t('api.policy.plannedHeading', 'professional')}`);
    for (const op of r.specOnly.filter((op) => r.policy.planned.includes(op.routeId))) lines.push(`- ${op.op}`);
    lines.push('');
  }
  if (missing.length) {
    lines.push('## declared, not implemented');
    for (const s of missing) lines.push(`- ${s.op}${s.summary ? ` — ${s.summary}` : ''}`);
    lines.push('');
  }
  if (r.codeOnly.length) {
    lines.push(
      r.counts.implementedBreakdown
        ? `## ${t('api.declared.absentSpec', 'professional')}`
        : '## implemented, not declared',
    );
    for (const c of r.codeOnly)
      lines.push(
        `- ${c.name}${r.policy.internal.includes(c.routeId) ? ` (${t('api.policy.internalDeclaration', 'professional')})` : ''}${c.loc ? ` — ${c.loc.path}:${c.loc.line}` : ''}`,
      );
    lines.push('');
  }
  const mism = r.matched.filter((m) => m.contract.drift?.length);
  if (mism.length) {
    lines.push('## matched with differences');
    for (const m of mism) {
      lines.push(
        `- ${m.op}${m.matchedBy === 'basePath' ? ' (matched via server base path)' : ''}${m.loc ? ` — ${m.loc.path}:${m.loc.line}` : ''}`,
      );
      for (const d of m.contract.drift!) lines.push(`    ${d.kind}: ${d.message}`);
    }
    lines.push('');
  }
  if (!r.policy.counts.drift) lines.push(t('api.policy.clean', 'professional'));
  if (r.notes?.length) {
    lines.push('', '## notes — not drift, never fails --strict');
    for (const n of r.notes) lines.push(`- ${n.op}: ${n.message}`);
  }
  return lines.join('\n');
}

/** Same for a node's stored contract, one line per fact — the MCP describe_node block. */
export function contractLines(c: OperationContract): string[] {
  const lines: string[] = [];
  lines.push(
    `  contract: ${c.status}${c.spec ? ` · ${c.spec.path}${c.spec.line != null ? `:${c.spec.line}` : ''}` : ''}${c.spec?.operationId ? ` · operationId ${c.spec.operationId}` : ''}`,
  );
  if (c.summary) lines.push(`    summary: ${c.summary}`);
  if (c.deprecated) lines.push('    deprecated: true');
  if (c.params?.length)
    lines.push(
      `    params: ${c.params.map((p) => `${p.name} (${p.in}${p.required ? ', required' : ''}${p.type ? `, ${p.type}` : ''})`).join(', ')}`,
    );
  if (c.requestBody)
    lines.push(
      `    request body: ${c.requestBody.schema ?? c.requestBody.contentType ?? 'declared'}${c.requestBody.required ? ' (required)' : ''}${c.requestBody.fields?.length ? ` { ${c.requestBody.fields.join(', ')} }` : ''}`,
    );
  if (c.responses?.length)
    lines.push(`    responses: ${c.responses.map((r) => `${r.status}${r.schema ? ` ${r.schema}` : ''}`).join(', ')}`);
  if (c.security?.length) lines.push(`    security: ${c.security.join(', ')}`);
  if (c.extensions && Object.keys(c.extensions).length)
    lines.push(
      `    extensions: ${Object.entries(c.extensions)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(', ')}`,
    );
  for (const d of c.drift ?? []) lines.push(`    ⚠ drift ${d.kind}: ${d.message}`);
  return lines;
}
