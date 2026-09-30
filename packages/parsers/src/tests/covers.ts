/**
 * What a test verifies, and how we know — the three evidence classes of
 * docs/proposals/tests-surface.md §3.2 steps 3–4.
 *
 * - **declared**: an `@covers` value the author wrote. A claim. Resolved in a
 *   documented order; what nothing matches stays verbatim on the node.
 * - **static**: what the test's own code touches — an imported symbol, a
 *   `render(<X/>)`, a `page.goto('/x')` literal, a `request.post('/x')` literal.
 *   An inference.
 *
 * Observed evidence lives in `reports.ts`. A claim never renders as an
 * observation: the evidence class travels on every edge.
 */
import { relative, dirname, resolve as resolvePath } from 'node:path';
import type { GraphNode, EdgeResolution, ConfidenceTier } from '@farsight/core';
import { walk, isNode, lineIndex, stringValue, memberChain, type AstNode } from '../walk.js';
import { normalizePath } from '../shared/tags.js';
import { resolveFileish } from '../aliases.js';

const ROUTE_RE = /^([A-Z]+)\s+(\/\S*)$/;

/** `/invoices/${id}` · `/invoices/:id` · `/invoices/{id}` · `/invoices/[id]` → one key. */
export function routeKey(path: string): string {
  return normalizePath(path.split('?')[0]!.split('#')[0]!)
    .replace(/\$\{[^}]*\}/g, ':param')
    .replace(/\[[^\]/]+\]/g, ':param')
    .replace(/\/+$/, '') || '/';
}

/** Where a `@covers` value can land, and a name index for the last-resort lookup. */
export class CoverTargets {
  private byId = new Map<string, GraphNode>();
  private flows = new Map<string, string>();
  private screens = new Map<string, string>();
  private steps = new Map<string, { nodeId: string; step: string }>();
  private routes = new Map<string, string>();
  private pages = new Map<string, string>();
  private byName = new Map<string, string[]>();

  constructor(nodes: GraphNode[], private repo: string) {
    for (const n of nodes) {
      this.byId.set(n.id, n);
      if (n.kind === 'test') continue;
      if (n.kind === 'flow') {
        const bare = n.id.split('::').pop()!;
        this.flows.set(bare.toLowerCase(), n.id);
        if (n.design?.id) this.flows.set(n.design.id.toLowerCase(), n.id);
      }
      if (n.design?.id) this.screens.set(n.design.id.toLowerCase(), n.id);
      // a screen's numbered steps: `@covers SCR-07.2` is a claim about one step of
      // SCR-07, not an unresolved id — the step travels on the edge (R33)
      for (const st of n.design?.steps ?? []) this.steps.set(st.id.toLowerCase(), { nodeId: n.id, step: st.id });
      if (n.kind === 'route') {
        const m = n.name.match(ROUTE_RE);
        if (m) this.routes.set(`${m[1]} ${routeKey(m[2]!)}`, n.id);
      }
      if (n.kind === 'page') this.pages.set(routeKey(n.name), n.id);
      const key = n.name.toLowerCase();
      if (!this.byName.has(key)) this.byName.set(key, []);
      this.byName.get(key)!.push(n.id);
    }
  }

  has(id: string): boolean { return this.byId.has(id); }
  node(id: string): GraphNode | undefined { return this.byId.get(id); }

  /**
   * An import `{ name }` from a repo file → the node that defines it. Exact when
   * the file declares it; through a barrel (`index.*` re-exporting `./x`) the
   * unique node of that name under the barrel's directory; last, a name unique
   * in the whole repo. Anything ambiguous resolves to nothing.
   */
  exported(file: string, name: string): string | undefined {
    const exact = `${this.repo}::${file}::${name}`;
    if (this.byId.has(exact)) return exact;
    const named = this.byName.get(name.toLowerCase()) ?? [];
    if (!named.length) return undefined;
    if (/(^|\/)index\.[cm]?[jt]sx?$/.test(file)) {
      const dir = file.replace(/[^/]*$/, '');
      const under = named.filter((id) => (this.byId.get(id)?.loc?.path ?? '').startsWith(dir));
      if (under.length === 1) return under[0];
      if (under.length > 1) return undefined;
    }
    return named.length === 1 ? named[0] : undefined;
  }

  /** A `page.goto('/x')` literal → the page node at that route. */
  page(path: string): string | undefined { return this.pages.get(routeKey(path)); }

  /** A `request.post('/x')` literal → the route node for that method + path. */
  route(method: string, path: string): string | undefined {
    return this.routes.get(`${method.toUpperCase()} ${routeKey(path)}`);
  }

  /**
   * Resolve one `@covers` value, in the documented order: full node id · flow
   * id · design screen id · route `METHOD /path` · `repo::path::name` · a bare
   * symbol name that is unique in the repo. Ambiguous names resolve to nothing
   * and carry their candidates.
   */
  declared(value: string): { nodeId?: string; step?: string; candidates?: string[] } {
    const raw = value.trim();
    if (!raw) return {};
    if (this.byId.has(raw)) return { nodeId: raw };
    const lower = raw.toLowerCase();
    const flow = this.flows.get(lower);
    if (flow) return { nodeId: flow };
    const screen = this.screens.get(lower);
    if (screen) return { nodeId: screen };
    const step = this.steps.get(lower);
    if (step) return { nodeId: step.nodeId, step: step.step };
    const m = raw.match(ROUTE_RE);
    if (m) {
      const route = this.route(m[1]!, m[2]!);
      if (route) return { nodeId: route };
    }
    if (raw.startsWith('/')) {
      const page = this.page(raw);
      if (page) return { nodeId: page };
    }
    const qualified = `${this.repo}::${raw}`;
    if (this.byId.has(qualified)) return { nodeId: qualified };
    const named = this.byName.get(lower) ?? [];
    if (named.length === 1) return { nodeId: named[0]! };
    if (named.length > 1) return { candidates: named.slice(0, 5) };
    return {};
  }
}

/** One thing a test file's code touches, before it is matched to a node. */
export interface StaticSignal {
  kind: 'symbol' | 'render' | 'goto' | 'request';
  /** symbol/render: the local identifier · goto: the url literal · request: `METHOD /path` */
  value: string;
  /** symbol only: the repo-relative file + exported name the import resolved to */
  target?: { file: string; name: string };
  line: number;
  /** the identifier is also called (or rendered) in the file — not merely imported */
  used?: boolean;
  /** the signal came from a helper this file calls, not from the file itself */
  viaHelper?: string;
}

export interface FileSignals {
  /** local name → what it imports */
  imports: Map<string, { file: string; name: string }>;
  signals: StaticSignal[];
  /** identifiers called anywhere in the file */
  called: Set<string>;
  /** identifier → the lines it is called/rendered on, so a case can claim only what it actually exercises */
  calledAt: Map<string, number[]>;
}

/**
 * Relative import → repo-relative file, the same resolution the TS/JS adapter
 * uses — plus the build twin: a test that imports the emitted `../dist/x.js`
 * (Farsight's own suites do, so they run against the build) is evidence for
 * `../src/x.ts`, which is what the graph holds. `dist/` itself is never
 * ingested, so the twin is tried first and the emitted file only as a fallback.
 */
function resolveRelative(repoRoot: string, importerAbs: string, spec: string): string | null {
  const base = resolvePath(dirname(importerAbs), spec);
  const twin = /(^|\/)(dist|build|lib|out)\//.test(spec) ? base.replace(/\/(dist|build|lib|out)\//, '/src/') : null;
  const hit = (twin && resolveFileish(twin)) || resolveFileish(base);
  return hit ? relative(repoRoot, hit) : null;
}

const REQUEST_HOLDERS = new Set(['request', 'apiRequest', 'api', 'context']);
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);
const RENDERERS = new Set(['render', 'renderHook', 'mount']);

/**
 * Read a parsed file for everything that is evidence of what it exercises:
 * imports, calls, `render(<X/>)`, `page.goto('/x')`, `request.post('/x')`.
 * Used for the test file itself and, one level down, for the helpers it calls.
 */
export function fileSignals(
  program: AstNode,
  source: string,
  abs: string,
  repoRoot: string,
  resolveAlias: (importerAbs: string, spec: string) => string | null,
): FileSignals {
  const line = lineIndex(source);
  const imports = new Map<string, { file: string; name: string }>();
  const signals: StaticSignal[] = [];
  const called = new Set<string>();
  const calledAt = new Map<string, number[]>();
  const noteUse = (name: string, at: number) => {
    called.add(name);
    if (!calledAt.has(name)) calledAt.set(name, []);
    calledAt.get(name)!.push(at);
  };

  const resolveSpec = (src: string): string | null =>
    src.startsWith('.') ? resolveRelative(repoRoot, abs, src) : resolveAlias(abs, src);

  walk(program, (n) => {
    if (n.type === 'ImportDeclaration') {
      const src = stringValue(n.source);
      const target = src ? resolveSpec(src) : null;
      if (!target) return false;
      for (const spec of (n.specifiers as AstNode[]) ?? []) {
        const local = (spec.local as AstNode | undefined)?.name;
        const imported = (spec.imported as AstNode | undefined)?.name;
        if (typeof local === 'string') imports.set(local, { file: target, name: typeof imported === 'string' ? imported : local });
      }
      return false;
    }
    if (n.type === 'JSXElement') {
      const opening = n.openingElement as AstNode | undefined;
      const nameNode = opening?.name as AstNode | undefined;
      const tag = nameNode && (nameNode.type === 'JSXIdentifier' || nameNode.type === 'Identifier') ? String(nameNode.name) : null;
      if (tag && /^[A-Z]/.test(tag)) { noteUse(tag, line(n.start ?? 0)); signals.push({ kind: 'render', value: tag, line: line(n.start ?? 0), used: true }); }
      return;
    }
    if (n.type !== 'CallExpression') return;
    const chain = memberChain(n.callee);
    const args = (n.arguments as AstNode[]) ?? [];
    if (chain.length === 1) {
      noteUse(chain[0]!, line(n.start ?? 0));
      if (RENDERERS.has(chain[0]!)) {
        const first = args[0];
        if (isNode(first) && first.type === 'Identifier') { noteUse(String(first.name), line(n.start ?? 0)); signals.push({ kind: 'render', value: String(first.name), line: line(n.start ?? 0), used: true }); }
      }
      return;
    }
    if (chain.length > 1) noteUse(chain[0]!, line(n.start ?? 0));
    const tail = chain[chain.length - 1]!;
    const head = chain[0]!;
    // page.goto('/submit') — the screen a browser test opens
    if (tail === 'goto') {
      const url = stringValue(args[0]);
      if (url) signals.push({ kind: 'goto', value: url, line: line(n.start ?? 0), used: true });
      return;
    }
    // request.post('/api/v1/submissions') — the endpoint an API test calls
    if (HTTP_VERBS.has(tail) && (REQUEST_HOLDERS.has(head) || chain.length >= 2)) {
      const url = stringValue(args[0]);
      if (url && url.startsWith('/')) {
        signals.push({ kind: 'request', value: `${tail === 'fetch' ? 'GET' : tail.toUpperCase()} ${url}`, line: line(n.start ?? 0), used: true });
      }
      return;
    }
  });

  // an imported identifier the file also calls or renders is stronger evidence: one
  // signal per call site (so a case can claim only what it exercises), and one
  // line-0 signal for an import nothing in the file calls
  for (const [local, target] of imports) {
    const uses = calledAt.get(local) ?? [];
    if (uses.length) for (const at of uses) signals.push({ kind: 'symbol', value: local, target, line: at, used: true });
    else signals.push({ kind: 'symbol', value: local, target, line: 0 });
  }
  return { imports, signals, called, calledAt };
}

/** The confidence tiers of §3.1, as one table so no consumer invents its own. */
export function staticResolution(signal: StaticSignal, exact: boolean): EdgeResolution {
  const tier = (c: ConfidenceTier, technique: EdgeResolution['technique'], note?: string): EdgeResolution =>
    ({ status: c === 'LOW' ? 'heuristic' : 'resolved', technique, confidence: c, ...(note ? { note } : {}) });
  if (signal.kind === 'symbol') {
    return signal.used
      ? tier('HIGH', 'import-resolution', 'imported and called by the test')
      : tier('MEDIUM', 'import-resolution', 'imported by the test, no call site found');
  }
  if (signal.kind === 'render') return tier('HIGH', 'import-resolution', 'rendered by the test');
  if (!exact) return tier('LOW', 'route-literal', 'the literal is a template — the match is a shape, not a path');
  return signal.viaHelper
    ? tier('MEDIUM', 'route-literal', `through the helper ${signal.viaHelper}`)
    : tier('MEDIUM', 'route-literal', 'a URL literal in the test');
}
