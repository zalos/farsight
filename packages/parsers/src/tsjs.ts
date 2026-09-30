import { readFileSync } from 'node:fs';
import { relative, dirname, resolve as resolvePath } from 'node:path';
import { parseSync } from 'oxc-parser';
import type { GraphFragment, GraphNode, GraphEdge, NodeKind, BranchPoint, BranchArm, ExternalDecl, ExternalKind, ExternalRef } from '@farsight/core';
import { walk, isNode, lineIndex, stringValue, memberChain, type AstNode } from './walk.js';
import { createAliasResolver, resolveFileish } from './aliases.js';
import type { LanguageAdapter, IngestOptions } from './types.js';
import { collectFiles, freshnessMeta } from './shared/files.js';
import { parseDoc, docCommentAbove, docLinkFields } from './shared/docs.js';
import { capLabel, leadingBranchLabel, trailingBranchLabel, NEGATE_FLIP } from './shared/labels.js';
import { autoTags, normalizePath, snippetRange } from './shared/tags.js';
import { isTestFile } from './tests/cases.js';
import { sqlTables, sqlOps, looksLikeSql } from './shared/sql.js';

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const ROUTE_FILE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ROUTER_NAMES = new Set(['router', 'app']);
const WRITE_OPS = new Set(['insert', 'update', 'delete', 'upsert', 'create']);
const READ_OPS = new Set(['findMany', 'findOne', 'findFirst', 'find', 'select', 'query']);
const TABLE_FACTORIES = new Set(['pgTable', 'mysqlTable', 'sqliteTable']); // Drizzle schema-as-code
const MAX_BRANCH_POINTS = 24; // per node — zero graph bloat beyond the field
/**
 * Third-party systems a package specifier names outright (01 §2.3.4, the first of
 * the three sources). A function that *uses* one of these imported bindings reaches
 * that system; the SDK is the evidence. `node: false` means the specifier is
 * recognised but makes no external node: Postgres is the records row, never a third
 * party, and the queue nodes already come from `getQueueClient(NAME)`.
 * `farsight.config.json → externals` entries whose `import` is a bare specifier
 * merge over this table and always make a node.
 */
const SDK_EXTERNALS: Record<string, { name: string; kind: ExternalKind; node: boolean }> = {
  '@azure-rest/ai-document-intelligence': { name: 'Azure Document Intelligence', kind: 'ocr', node: true },
  '@azure/storage-blob': { name: 'Azure Blob Storage', kind: 'files', node: true },
  '@azure/communication-email': { name: 'Azure Communication Services', kind: 'email', node: true },
  '@azure/storage-queue': { name: 'Azure Storage Queue', kind: 'queue', node: false },
  pg: { name: 'Postgres', kind: 'db', node: false },
};
// `BC_API_HOST` — a name that reads like a configured host, not a local variable
const HOST_CONST = /^[A-Z][A-Z0-9_]*$/;
// Two resolutions the db pass hands out, once each (B5.1 — docs/proposals/dependency-impact.md §3.4).
// `db-builder` is a structural match on a builder chain, so nothing was guessed; `raw-sql` read the
// table's name out of the statement the function runs, which is a text parse of code that is real —
// HIGH because no name was guessed and no candidate was picked, `heuristic` because a string that is
// assembled elsewhere, or handed to another function to run, is the way it can be wrong.
// A fresh object per edge, never a shared one: an edge's resolution belongs to that edge.
const DB_BUILDER = (): GraphEdge['resolution'] =>
  ({ status: 'resolved', technique: 'db-builder', confidence: 'HIGH', note: 'a builder chain names the table' });
const RAW_SQL = (): GraphEdge['resolution'] =>
  ({ status: 'heuristic', technique: 'raw-sql', confidence: 'HIGH', note: 'the table name was read out of the statement on this edge' });
// member calls on these names are the runtime's, never a class of the repo — no method-name resolution
const BUILTIN_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'map', 'filter', 'forEach', 'reduce', 'find', 'findIndex', 'some', 'every', 'join', 'split',
  'slice', 'splice', 'concat', 'includes', 'indexOf', 'keys', 'values', 'entries', 'get', 'set', 'has', 'delete', 'add', 'clear', 'then', 'catch', 'finally',
  'toString', 'toJSON', 'json', 'text', 'trim', 'replace', 'match', 'test', 'exec', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'sort', 'flat',
  'flatMap', 'fill', 'at', 'from', 'of', 'assign', 'freeze', 'parse', 'safeParse', 'stringify', 'log', 'warn', 'error', 'info', 'debug', 'query', 'connect',
  'release', 'end', 'on', 'off', 'once', 'emit', 'next', 'return', 'throw', 'bind', 'call', 'apply', 'append', 'getTime', 'toISOString', 'now', 'resolve',
  'reject', 'all', 'race', 'padStart', 'padEnd', 'charAt', 'substring', 'substr', 'toFixed', 'localeCompare', 'reverse', 'length', 'size', 'close', 'open',
  'write', 'read', 'send', 'status', 'header', 'headers', 'redirect', 'cookies', 'nextUrl', 'formData', 'arrayBuffer', 'blob', 'clone']);
// a class or file named like a stand-in: the production twin wins a method-name resolution
const TEST_DOUBLE = /(^|[\/\-_.])(in-?memory|mock|fake|stub|noop|dummy)/i;
// a callback handed to one of these runs inside the caller's transaction — the
// drill's transaction boundary is a parser fact, not a first-to-last-write guess
const TX_CALLEES = new Set(['withOps', 'withTenant', 'withTx', 'transaction', '$transaction']);
// `build().catch(…)` is still the call to `build`: these tails decorate a promise, they do not make the value
const PROMISE_TAILS = new Set(['catch', 'then', 'finally']);
// a file that parks a value on a process-wide slot is booting a singleton — `x ??= build()` in it is start-up (01 §2.3.3)
const SINGLETON_MARKERS = ['Symbol.for(', 'globalThis'];
// a schema that describes the process, not the business: it gates the boot, never a user (01 §2.3.6 a)
const ENV_SCHEMA_NAME = /(Env|Config)Schema$/;
const ENV_SCHEMA_BASENAME = /^(?:env|.+-env|config)\.[cm]?[jt]sx?$/;

interface Sym {
  nodeId: string;
  file: string; // repo-relative path
  name: string;
  exported: boolean;
}

/**
 * A type as far as syntax can see it: a name the file can look up, or an inline object
 * literal, which names nothing (01 §2.3.5). Anything else — a union, a generic, a
 * keyword — is no reference at all and leaves the call to the name rules.
 */
type TypeRef = { name: string } | { literal: Map<string, TypeRef> };

/** An interface, a class, or an object-literal type alias, as declared in one file. */
interface TypeDecl {
  kind: 'interface' | 'class' | 'alias';
  file: string;
  name: string;
  /** property name → its declared type: what an `a.b.method()` path walks through */
  props: Map<string, TypeRef>;
  /** the names in `class C implements A, B` */
  implements: string[];
}

/** Where a site sits, from the ancestor scan (01 §2.3.1) — stamped on every edge it makes. */
interface SiteFlags {
  /** inside a function expression stored as an object-literal property: run later, by someone else */
  deferred: boolean;
  /** inside a withOps / withTenant / withTx / transaction callback */
  tx: boolean;
}

/** A site with no function expression above it: a route's own body, a page's render. */
const NO_FLAGS: SiteFlags = { deferred: false, tx: false };

interface HttpCallSite {
  fromId: string;
  method: string;
  path: string;
  line?: number;
  deferred: boolean;
  tx: boolean;
}

/** Parse a TS/JS repo into a GraphFragment. Heuristic, syntax-level extraction. */
export function ingestTsJs(repoPath: string, options: IngestOptions = {}): GraphFragment {
  const repoRoot = resolvePath(repoPath);
  const repo = options.repoName ?? repoRoot.split('/').filter(Boolean).pop()!;
  const files = collectFiles(repoRoot, EXTS, options, (name) => name.endsWith('.d.ts')).sort();
  const meta = freshnessMeta(repoRoot, files);
  // spec files belong to the tests adapter: it emits `test` nodes + `covers` edges
  // from them. Walking them here as ordinary source is what used to leave stray
  // `function` nodes behind (docs/proposals/tests-surface.md §3.2 step 1).
  const claimsTests = options.tests !== false;

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const symbols: Sym[] = []; // all declared functions/components, for call resolution
  // file -> local name -> { file: resolved repo-relative path, name: exported name at the source }
  const importsByFile = new Map<string, Map<string, { file: string; name: string }>>();
  // file -> its re-exports, so lookups can follow barrel files (`export * from './x'`)
  const reexportsByFile = new Map<string, { stars: string[]; named: Map<string, { file: string; name: string }> }>();
  const resolveAlias = createAliasResolver(repoRoot);
  // call-site `line` (1-based, in the caller's file) orders callees so a
  // journey can replay them in the order the code runs
  const pendingCalls: { fromId: string; file: string; callee: string; line?: number; deferred: boolean; tx: boolean }[] = [];
  const pendingRenders: { fromId: string; file: string; callee: string; line?: number; jsx?: true; deferred: boolean; tx: boolean }[] = [];
  const httpCalls: HttpCallSite[] = [];
  // Drizzle-style ops name the table via an identifier argument — resolution
  // (imports, barrels, pgTable declarations) has to wait for pass 2
  const pendingDbOps: { fromId: string; file: string; tableName: string; op: string; write: boolean; code: string; line?: number; sql?: boolean; deferred: boolean; tx: boolean }[] = [];
  // a.b.method(…) — resolved in pass 2 to the one class method of that name (DI by name, not by type)
  const pendingMethodCalls: { fromId: string; file: string; method: string; receiver: string; line?: number; deferred: boolean; tx: boolean }[] = [];
  const methodIndex = new Map<string, { nodeId: string; cls: string; file: string }[]>();
  // `this.<field>.<…>.<fn>()` inside a class — a callback the constructor was handed;
  // pass 2 matches it against the object literal of a `new Class({ … })` somewhere else
  const pendingHookCalls: { fromId: string; file: string; cls: string; path: string[]; line?: number; deferred: boolean; tx: boolean; tagIfUnbound?: boolean }[] = [];
  // file -> the interfaces, classes and object-literal aliases it declares (01 §2.3.5)
  const typesByFile = new Map<string, Map<string, TypeDecl>>();
  // a member call whose receiver has a declared type: pass 2 follows the type to the
  // classes that implement it, instead of guessing by method name. `fallback` is the
  // record the call would have been had the type turned out to name nothing.
  const pendingTypedCalls: {
    fromId: string; file: string; root: TypeRef; path: string[]; method: string; line?: number;
    deferred: boolean; tx: boolean;
    fallback: { kind: 'method'; receiver: string } | { kind: 'hook'; cls: string; path: string[] };
  }[] = [];
  const hookBindings: { file: string; className: string; classRef: { file: string; name: string }; path: string; fnId: string; line: number }[] = [];
  // `${file}::${ClassName}` for every class declared in the repo — hook bindings resolve through it
  const classDecls = new Set<string>();
  // node ids of builders found by the `??=` singleton heuristic: the callee may be declared
  // further down its file, so the `setup` tag is applied once pass 1 has every node
  const pendingSetupTags = new Set<string>();
  // `const NAME = 'literal'` per file — queue names and the like travel through imports as constants
  const constStrings = new Map<string, string>();
  // queue SDK calls (Azure Storage Queue today): the bound client's name → publishes / consumes
  const pendingQueueOps: { fromId: string; file: string; queue: { literal?: string; ref?: string }; kind: 'publishes' | 'consumes'; line?: number; deferred: boolean; tx: boolean }[] = [];
  // ── externals, three sources (01 §2.3.4) ──
  // a function that used an imported SDK binding: pass 3 turns the first use into one
  // `http` edge to that SDK's system. The node is only ever made because an edge
  // reaches it, so a recognised import nothing uses leaves nothing behind.
  const sdkUses: { fromId: string; file: string; via?: string; specifier: string; name: string; kind: ExternalKind; line?: number }[] = [];
  const markedSdk = new Set<string>(); // `${fromId}|${name}` — the first reference marks the function
  // a non-literal `fetch` inside a class whose base URL starts with a constant host
  const pendingHostCalls: { fromId: string; file: string; cls: string; constName: string; method: string; line?: number; deferred: boolean; tx: boolean }[] = [];
  // every `fetch(` site inside a class method, keyed `${file}::${Class}` — what a
  // `<path>::<Class>` declaration attaches its edges to when nothing was detected
  const classFetchSites = new Map<string, { fromId: string; method: string; line?: number }[]>();
  // Next.js App Router bookkeeping (file conventions are the router)
  const appPages: { nodeId: string; appRoot: string; dir: string }[] = [];
  const appApiRoutes: { nodeId: string; appRoot: string; dir: string }[] = [];
  const appLayouts: { fnId: string; appRoot: string; dir: string }[] = [];
  const middlewares: { file: string; prefix: string }[] = [];
  // a route that delegates its body to a named function: the handler *is* the route's body
  const routeHandlers: { routeId: string; file: string; handler: string }[] = [];
  let edgeSeq = 0;

  const addNode = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return nodes.get(n.id)!;
  };
  const addEdge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta'], resolution?: GraphEdge['resolution']) => {
    edges.push({ id: `e${edgeSeq++}`, kind, from, to, ...(meta ? { meta } : {}), ...(resolution ? { resolution } : {}) });
  };
  /**
   * How a symbol reference was resolved, as an EdgeResolution. `same-file` and
   * `static-import` are the two routes `resolveTarget` can take and nothing else
   * was guessed on either, so both are HIGH. An edge whose *kind* rests on a
   * separate fact (a @guard annotation, a JSX element) names that fact instead —
   * see the call sites; the route is kept in the note so nothing is lost.
   */
  const bySymbol = (via: 'same-file' | 'static-import'): GraphEdge['resolution'] => ({
    status: 'resolved', technique: via, confidence: 'HIGH',
    note: via === 'same-file' ? 'declared in the same file' : 'the import resolved on disk',
  });
  const symbolId = (file: string, name: string) => `${repo}::${file}::${name}`;

  // the SDK table with the repo's own declarations merged over it: a bare specifier
  // renames/re-kinds a row (and always makes a node), a `<path>::<Class>` entry is the
  // other kind of declaration — a client class this parser could not have typed
  const sdkTable = new Map(Object.entries(SDK_EXTERNALS));
  const declaredClassExternals = new Map<string, ExternalDecl>();
  for (const decl of options.externals ?? []) {
    if (decl.import.includes('::')) declaredClassExternals.set(decl.import.replace(/^\.\//, ''), decl);
    else sdkTable.set(decl.import, { name: decl.name, kind: decl.kind, node: true });
  }
  /** The table row an import specifier names — exactly, or as the root of a subpath import. */
  const sdkEntry = (spec: string) => {
    const exact = sdkTable.get(spec);
    if (exact) return { spec, ...exact };
    for (const [key, row] of sdkTable) if (spec.startsWith(key + '/')) return { spec: key, ...row };
    return undefined;
  };

  /**
   * Two facts about *where* a site sits, read once from its ancestors
   * (the clarity-phase plan §2.3.1):
   * - `deferred` — some ancestor function expression is an object-literal
   *   property value: a callback stored for later, not this call's own work.
   *   A function expression passed as a call *argument*, returned, put in a JSX
   *   container or assigned to a declarator is NOT deferred — the submit
   *   transaction inside `withOps(async () => …)` stays the caller's.
   * - `tx` — some ancestor function expression is a direct argument of a call
   *   whose member-chain tail is a transaction runner.
   */
  const scanAncestors = (parents: AstNode[]): SiteFlags => {
    let deferred = false;
    let tx = false;
    for (let i = parents.length - 1; i >= 0; i--) {
      const f = parents[i]!;
      if (f.type !== 'ArrowFunctionExpression' && f.type !== 'FunctionExpression') continue;
      const up = i > 0 ? parents[i - 1]! : undefined;
      if (!up) continue;
      if (up.type === 'Property' && up.value === f) deferred = true;
      else if (up.type === 'CallExpression' && Array.isArray(up.arguments)
        && (up.arguments as AstNode[]).includes(f) && TX_CALLEES.has(memberChain(up.callee).pop() ?? '')) tx = true;
    }
    return { deferred, tx };
  };
  /** Stamp `deferred` / `tx` on an edge's meta — only when set, never `false`. */
  const withFlags = (base: GraphEdge['meta'] | undefined, f: SiteFlags): GraphEdge['meta'] | undefined => {
    if (!f.deferred && !f.tx) return base;
    return { ...(base ?? {}), ...(f.deferred ? { deferred: true } : {}), ...(f.tx ? { tx: true } : {}) };
  };

  // ── pass 1: per-file extraction ────────────────────────────────
  for (const abs of files) {
    const file = relative(repoRoot, abs);
    const source = readFileSync(abs, 'utf8');
    if (claimsTests && isTestFile(file, source, options.testGlobs ?? {})) continue;
    const line = lineIndex(source);
    let program: AstNode;
    try {
      const result = parseSync(abs, source);
      program = (typeof result.program === 'string' ? JSON.parse(result.program) : result.program) as AstNode;
    } catch {
      continue; // unparsable file: skip, never fail the ingest
    }
    // this file keeps something alive for the whole process — the precondition
    // the `??=` builder heuristic needs before it calls anything start-up
    const singletonFile = SINGLETON_MARKERS.some((m) => source.includes(m));
    const envSchemaFile = ENV_SCHEMA_BASENAME.test(file.split('/').pop() ?? '');

    // relative imports resolve on the filesystem; bare specifiers go through
    // tsconfig paths / workspace packages (monorepo cross-package edges)
    const resolveSpec = (src: string): string | null =>
      src.startsWith('.') ? resolveImport(repoRoot, abs, src) : resolveAlias(abs, src);

    // imports: local name -> { target file, exported name } (handles `import { a as b }`)
    const importMap = new Map<string, { file: string; name: string }>();
    // local name -> the third-party system that package is (01 §2.3.4); per file, like importMap
    const sdkImports = new Map<string, { spec: string; name: string; kind: ExternalKind }>();
    // class name -> the UPPER_SNAKE constant its base URL starts with
    const classHosts = new Map<string, { constName: string }>();
    const reexports = { stars: [] as string[], named: new Map<string, { file: string; name: string }>() };
    // the types this file declares, and the typed fields of each class it declares
    const types = new Map<string, TypeDecl>();
    const fieldTypes = new Map<string, Map<string, TypeRef>>();
    importsByFile.set(file, importMap);
    reexportsByFile.set(file, reexports);
    typesByFile.set(file, types);
    walk(program, (n) => {
      if (n.type === 'ImportDeclaration') {
        const src = stringValue(n.source);
        // an SDK specifier names a third-party system outright — and never resolves on
        // disk, so this has to happen before the unresolved-import bail below
        const sdk = src ? sdkEntry(src) : undefined;
        if (sdk?.node) {
          for (const spec of (n.specifiers as AstNode[]) ?? []) {
            const local = (spec.local as AstNode | undefined)?.name;
            if (typeof local === 'string') sdkImports.set(local, { spec: sdk.spec, name: sdk.name, kind: sdk.kind });
          }
        }
        const target = src ? resolveSpec(src) : null;
        if (!target) return false;
        for (const spec of (n.specifiers as AstNode[]) ?? []) {
          const local = (spec.local as AstNode | undefined)?.name;
          const imported = (spec.imported as AstNode | undefined)?.name;
          if (typeof local === 'string') {
            importMap.set(local, { file: target, name: typeof imported === 'string' ? imported : local });
          }
        }
        return false;
      }
      // export * from './x' — barrel files; lookups follow these
      if (n.type === 'ExportAllDeclaration' && !isNode(n.exported)) {
        const src = stringValue(n.source);
        const target = src ? resolveSpec(src) : null;
        if (target) reexports.stars.push(target);
        return false;
      }
      // export { a, b as c } from './x'
      if (n.type === 'ExportNamedDeclaration' && isNode(n.source)) {
        const src = stringValue(n.source);
        const target = src ? resolveSpec(src) : null;
        if (!target) return false;
        for (const spec of (n.specifiers as AstNode[]) ?? []) {
          const local = (spec.local as AstNode | undefined)?.name;
          const exported = (spec.exported as AstNode | undefined)?.name;
          if (typeof local === 'string' && typeof exported === 'string') {
            reexports.named.set(exported, { file: target, name: local });
          }
        }
        return false;
      }
    });

    // declared functions & components & zod schemas
    const declared: { name: string; node: AstNode; body: AstNode | null; kind: NodeKind; cls?: string; clsGroup?: string }[] = [];
    walk(program, (n, parents) => {
      // class methods are functions named Class.method, grouped under their class (or the class doc's @group)
      if (n.type === 'ClassDeclaration' && isNode(n.id)) {
        const cls = String((n.id as AstNode).name);
        classDecls.add(`${file}::${cls}`);
        const clsDoc = parseDoc(leadingComment(source, n.start ?? 0));
        for (const m of (((n.body as AstNode | undefined)?.body as AstNode[]) ?? [])) {
          if (m.type !== 'MethodDefinition' || m.kind === 'constructor' || !isNode(m.key) || !isNode(m.value)) continue;
          const key = m.key as AstNode;
          const mname = typeof key.name === 'string' ? key.name : typeof key.value === 'string' ? key.value : '';
          if (!mname) continue;
          declared.push({ name: `${cls}.${mname}`, node: m, body: ((m.value as AstNode).body as AstNode) ?? null, kind: 'function', cls, clsGroup: clsDoc.group ?? cls });
        }
        // the class's own base URL — `this.baseUrl = `${BC_API_HOST}/v2.0`` in the
        // constructor, or the same shape as a field initializer. A `fetch` in one of its
        // methods whose URL is built elsewhere still reaches that host (01 §2.3.4 R4b).
        for (const m of (((n.body as AstNode | undefined)?.body as AstNode[]) ?? [])) {
          if (m.type === 'PropertyDefinition') {
            const c = hostConstOf(m.value);
            if (c) classHosts.set(cls, { constName: c });
            continue;
          }
          if (m.type !== 'MethodDefinition' || m.kind !== 'constructor' || !isNode(m.value)) continue;
          walk((m.value as AstNode).body, (b) => {
            if (b.type !== 'AssignmentExpression' || b.operator !== '=' || memberChain(b.left)[0] !== 'this') return;
            const c = hostConstOf(b.right);
            if (c) classHosts.set(cls, { constName: c });
          });
        }
        // the class as a *type*: what it implements and the declared type of every
        // field — a `this.<field>.<method>()` starts here (01 §2.3.5)
        const props = new Map<string, TypeRef>();
        for (const m of (((n.body as AstNode | undefined)?.body as AstNode[]) ?? [])) {
          if (!isNode(m) || m.computed) continue;
          // `private readonly transport: EmailTransport` as a field …
          if (m.type === 'PropertyDefinition') {
            const key = m.key as AstNode | undefined;
            const mname = key && typeof key.name === 'string' ? String(key.name) : undefined;
            const ref = typeRefOf(m.typeAnnotation);
            if (mname && ref) props.set(mname, ref);
            continue;
          }
          // … or declared by the constructor: oxc wraps exactly those parameters that
          // carry `accessibility` / `readonly` in a TSParameterProperty
          if (m.type !== 'MethodDefinition' || m.kind !== 'constructor' || !isNode(m.value)) continue;
          for (const p of (((m.value as AstNode).params as AstNode[]) ?? [])) {
            if (!isNode(p) || p.type !== 'TSParameterProperty' || !isNode(p.parameter)) continue;
            const param = p.parameter as AstNode;
            const ref = param.type === 'Identifier' ? typeRefOf(param.typeAnnotation) : undefined;
            if (ref && typeof param.name === 'string') props.set(String(param.name), ref);
          }
        }
        const impls = (((n as AstNode).implements as AstNode[]) ?? [])
          .map((i) => (isNode(i) && isNode(i.expression) ? (i.expression as AstNode).name : undefined))
          .filter((x): x is string => typeof x === 'string');
        types.set(cls, { kind: 'class', file, name: cls, props, implements: impls });
        fieldTypes.set(cls, props);
        return false;
      }
      // `interface Notifier { send(to: string): Promise<void> }` — the shape a caller
      // declares it wants; pass 2 looks for the classes that promise to be it
      if (n.type === 'TSInterfaceDeclaration' && isNode(n.id)) {
        const name = String((n.id as AstNode).name);
        const members = (((n.body as AstNode | undefined)?.body as AstNode[]) ?? []);
        types.set(name, { kind: 'interface', file, name, props: typeMembers(members), implements: [] });
        return false;
      }
      // `type Deps = { repo: AuditRepository }` — a named shape a path can be walked through
      if (n.type === 'TSTypeAliasDeclaration' && isNode(n.id) && isNode(n.typeAnnotation)
        && (n.typeAnnotation as AstNode).type === 'TSTypeLiteral') {
        const name = String((n.id as AstNode).name);
        const members = (((n.typeAnnotation as AstNode).members as AstNode[]) ?? []);
        types.set(name, { kind: 'alias', file, name, props: typeMembers(members), implements: [] });
        return false;
      }
      // string constants: `export const QUEUE_DOCUMENTS = 'q-documents'`
      if (n.type === 'VariableDeclarator' && isNode(n.id) && (n.id as AstNode).type === 'Identifier' && isNode(n.init)
        && ((n.init as AstNode).type === 'Literal' || (n.init as AstNode).type === 'StringLiteral') && typeof (n.init as AstNode).value === 'string') {
        constStrings.set(`${file}::${String((n.id as AstNode).name)}`, String((n.init as AstNode).value));
      }
      // function declarations
      if (n.type === 'FunctionDeclaration' && isNode(n.id)) {
        const name = String((n.id as AstNode).name);
        declared.push({ name, node: n, body: (n.body as AstNode) ?? null, kind: 'function' });
        return;
      }
      // const foo = () => {} / function expression
      if (n.type === 'VariableDeclarator' && isNode(n.id) && (n.id as AstNode).type === 'Identifier' && isNode(n.init)) {
        const init = n.init as AstNode;
        const name = String((n.id as AstNode).name);
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
          // only top-level-ish declarations (not deeply nested helpers)
          if (parents.length <= 4) declared.push({ name, node: n, body: (init.body as AstNode) ?? null, kind: 'function' });
        } else if (init.type === 'CallExpression' && memberChain(init.callee)[0] === 'z') {
          const id = symbolId(file, name);
          addNode({
            id, kind: 'rule', name, lang: 'ts',
            loc: { repo, path: file, line: line(n.start ?? 0), endLine: line(n.end ?? 0) },
            // an env/config schema checks the process's own settings: it is a rule of the
            // code (list_rules keeps it) but never a gate a person passes (01 §2.3.6 a)
            tags: [...autoTags(file, name, 'rule'), ...(envSchemaFile || ENV_SCHEMA_NAME.test(name) ? ['env-schema'] : [])],
            signature: sourceSlice(source, init).slice(0, 200),
          });
        } else if (init.type === 'CallExpression' && TABLE_FACTORIES.has(memberChain(init.callee).pop() ?? '')) {
          // pgTable('claims', {…}) — schema-as-code yields authoritative table
          // nodes (with columns) long before any DB-introspection adapter
          const initArgs = (init.arguments as AstNode[]) ?? [];
          const tableName = stringValue(initArgs[0]) ?? name;
          const tableId = `${repo}::table::${tableName}`;
          const cols: string[] = [];
          if (isNode(initArgs[1]) && initArgs[1].type === 'ObjectExpression') {
            for (const prop of ((initArgs[1].properties as AstNode[]) ?? [])) {
              const key = prop.key as AstNode | undefined;
              const keyName = key && (key.name ?? key.value);
              if (typeof keyName === 'string') cols.push(keyName);
            }
          }
          addNode({
            id: tableId, kind: 'table', name: tableName, lang: 'ts',
            loc: { repo, path: file, line: line(n.start ?? 0) },
            tags: autoTags(file, tableName, 'table'),
            ...(cols.length ? { signature: `columns: ${cols.join(', ')}` } : {}),
          });
          // the variable is how code refers to the table — register it so
          // imported identifiers (and barrels) resolve to this node
          symbols.push({ nodeId: tableId, file, name, exported: true });
        }
      }
    });

    // CREATE TABLE in a string or template (migrations as code): authoritative
    // table nodes with their columns, the same ids the SQL reads/writes land on
    walk(program, (n) => {
      const text = sqlLiteralText(n);
      if (text == null) return;
      if (!/create\s+(?:temp(?:orary)?\s+|unlogged\s+)?table\b/i.test(text)) return false;
      for (const tbl of sqlTables(text)) {
        const tableId = `${repo}::table::${tbl.name}`;
        const at = line(n.start ?? 0) + (text.slice(0, tbl.offset).match(/\n/g) ?? []).length;
        const existing = nodes.get(tableId);
        if (existing && existing.loc) continue;
        nodes.set(tableId, {
          id: tableId, kind: 'table', name: tbl.name, lang: 'sql',
          loc: { repo, path: file, line: at },
          tags: autoTags(file, tbl.name, 'table'),
          ...(tbl.columns.length ? { signature: `columns: ${tbl.columns.join(', ')}` } : {}),
        });
      }
      return false;
    });

    const fileFunctionIds: string[] = [];
    const fileUseServer = hasDirective(program, 'use server');
    // names this file declares — the `??=` heuristic only ever points at one of them
    const declaredHere = new Set(declared.map((d) => d.name));
    for (const d of declared) {
      let kind: NodeKind = d.kind;
      let hasJsx = false;
      walk(d.body, (b) => {
        if (b.type === 'JSXElement' || b.type === 'JSXFragment') { hasJsx = true; return false; }
      });
      if (hasJsx && /^[A-Z]/.test(d.name)) kind = 'component';
      const id = symbolId(file, d.name);
      const doc = parseDoc(leadingComment(source, d.node.start ?? 0));
      // @guard — declared auth wrapper (withTenant(clientId, fn)…): a guard
      // node even before an adapter understands the framework it belongs to
      const isGuard = kind === 'function' && doc.guard !== undefined;
      if (isGuard) kind = 'guard';
      // 'use server' functions are the API endpoints of an App Router app —
      // surface them as routes so trace_flow/overview treat them as entry points
      const isServerAction = kind === 'function' && (fileUseServer || hasDirective(d.body, 'use server'));
      if (isServerAction) kind = 'route';
      const branches = kind === 'guard' ? [] : extractBranches(d.body, source, line);
      addNode({
        id, kind, name: isGuard && doc.guard ? `${d.name}: ${doc.guard}` : d.name, lang: langOf(file),
        loc: { repo, path: file, line: line(d.node.start ?? 0), endLine: line(d.node.end ?? 0) },
        docs: doc.docs,
        snippet: snippetOf(source, d.node),
        ...(branches.length ? { branches } : {}),
        group: doc.group ?? d.clsGroup,
        tags: [
          ...autoTags(file, d.name, kind), ...doc.tags,
          ...(isServerAction ? ['server-action'] : []),
          ...(isGuard && !doc.tags.includes('auth') ? ['auth'] : []),
          ...(doc.entrypoint ? ['entrypoint', ...doc.entrypoint] : []),
        ],
        ...(doc.business ? { facets: { business: { description: doc.business } } } : {}),
        ...docLinkFields(doc),
      });
      symbols.push({ nodeId: id, file, name: d.name, exported: true });
      if (kind === 'function') fileFunctionIds.push(id);
      if (d.cls) {
        const mname = d.name.slice(d.cls.length + 1);
        if (!methodIndex.has(mname)) methodIndex.set(mname, []);
        methodIndex.get(mname)!.push({ nodeId: id, cls: d.cls, file });
      }
      // the declared type of each parameter — what a member call's receiver resolves
      // through (01 §2.3.5). A destructured parameter (`{ provider }: { provider: Ocr }`)
      // binds names the annotation never names: it is skipped, an honest absence.
      const paramTypes = new Map<string, TypeRef>();
      for (const p of paramsOf(d.node)) {
        const param = p.type === 'TSParameterProperty' && isNode(p.parameter) ? (p.parameter as AstNode) : p;
        if (param.type !== 'Identifier' || typeof param.name !== 'string') continue;
        const ref = typeRefOf(param.typeAnnotation);
        if (ref) paramTypes.set(String(param.name), ref);
      }
      // body-level extraction: calls, fetch, db access, publish, JSX renders.
      // Runs once per declared function and again, recursively, for every callback
      // it stores as an object-literal property (01 §2.3.1).
      const walkedCallbacks = new Set<string>();
      const walkBody = (bodyNode: AstNode | null, fromId: string, hostPath: string, hostGroup?: string): void => {
        // queue clients bound inside this body: `const q = svc.getQueueClient(NAME)` → q → NAME
        const queueVars = new Map<string, { literal?: string; ref?: string }>();
        walk(bodyNode, (b, bodyParents) => {
          // a function expression stored as an object-literal property is a callback:
          // someone will run it later. It becomes a node of its own with its own body
          // walk, so its work is its own and the host only gets a `deferred` edge to it.
          if (b.type === 'ArrowFunctionExpression' || b.type === 'FunctionExpression') {
            const up = bodyParents[bodyParents.length - 1];
            if (up && up.type === 'Property' && up.value === b && hoistCallback(b, up, bodyParents, fromId, hostPath, hostGroup)) return false;
            return;
          }
          // an imported SDK binding used here: this function reaches that third-party
          // system (01 §2.3.4). The first reference marks the function; a property *name*
          // that happens to spell the local is not a use of it.
          if (b.type === 'Identifier' && sdkImports.size) {
            const sdk = sdkImports.get(String(b.name));
            const up = bodyParents[bodyParents.length - 1];
            const isName = !!up && !up.computed
              && (((up.type === 'MemberExpression' || up.type === 'StaticMemberExpression') && up.property === b) || (up.type === 'Property' && up.key === b));
            if (sdk && !isName && !markedSdk.has(`${fromId}|${sdk.name}`)) {
              markedSdk.add(`${fromId}|${sdk.name}`);
              sdkUses.push({ fromId, file, ...(d.cls ? { via: d.cls } : {}), specifier: sdk.spec, name: sdk.name, kind: sdk.kind, line: line(b.start ?? 0) });
            }
            return;
          }
          // SQL in a template or string literal: the tables the statement reads and writes
          // (the string is the query — code is the source of truth, whatever client runs it)
          const sqlText = sqlLiteralText(b);
          if (sqlText != null) {
            if (looksLikeSql(sqlText)) {
              const ops = sqlOps(sqlText);
              const code = sqlText.replace(/\s+/g, ' ').trim().slice(0, 200);
              const sf = scanAncestors(bodyParents);
              for (const o of ops) pendingDbOps.push({ fromId, file, tableName: o.table, op: o.op, write: o.write, code, line: line(b.start ?? 0), sql: true, ...sf });
            }
            return false;
          }
          if (b.type === 'VariableDeclarator' && isNode(b.id) && (b.id as AstNode).type === 'Identifier' && isNode(b.init)
            && (b.init as AstNode).type === 'CallExpression' && memberChain((b.init as AstNode).callee).pop() === 'getQueueClient') {
            const arg = (((b.init as AstNode).arguments as AstNode[]) ?? [])[0];
            const literal = stringValue(arg);
            if (literal) queueVars.set(String((b.id as AstNode).name), { literal });
            else if (isNode(arg) && arg.type === 'Identifier') queueVars.set(String((b.id as AstNode).name), { ref: String(arg.name) });
          }
          // <ChildComponent …/> → renders edge (embedded components)
          if (b.type === 'JSXElement') {
            const tag = jsxName(b);
            if (tag && /^[A-Z]/.test(tag) && tag !== d.name) pendingRenders.push({ fromId, file, callee: tag, line: line(b.start ?? 0), jsx: true, ...scanAncestors(bodyParents) });
            return;
          }
          // `h.promise ??= build().catch(…)` in a file that parks a process-wide
          // singleton: `build` is the container builder, and everything reached only
          // from it is start-up, not this request's work (01 §2.3.3). The tag lands on
          // the callee — which may be declared further down — so it waits for pass 1's end.
          if (b.type === 'AssignmentExpression' && (b.operator === '??=' || b.operator === '||=') && singletonFile) {
            const builder = innermostCallee(b.right);
            if (builder && declaredHere.has(builder)) pendingSetupTags.add(symbolId(file, builder));
            return; // the right-hand side is walked anyway: the `calls` edge is made below
          }
          if (b.type !== 'CallExpression') return;
          const f = scanAncestors(bodyParents);
          const chain = memberChain(b.callee);
          const args = (b.arguments as AstNode[]) ?? [];
          // query code for the edge: the whole enclosing statement, so builder
          // chains (db.insert(t).values(…)) show up complete
          const queryCode = () => {
            const stmt = [...bodyParents].reverse().find((p) =>
              p.type === 'ExpressionStatement' || p.type === 'VariableDeclarator' || p.type === 'ReturnStatement') ?? b;
            return sourceSlice(source, stmt).replace(/\s+/g, ' ').slice(0, 200);
          };

          // fetch('/x', {method:'POST'})
          if (chain.length === 1 && chain[0] === 'fetch') {
            const url = stringValue(args[0]);
            const at = line(b.start ?? 0);
            const verb = fetchMethod(args[1]);
            if (url) httpCalls.push({ fromId, method: verb, path: normalizePath(url), line: at, ...f });
            // a class that keeps its base URL in a constant is talking to that host even
            // when the URL itself is assembled somewhere else (01 §2.3.4 R4b)
            else if (d.cls && classHosts.has(d.cls)) {
              pendingHostCalls.push({ fromId, file, cls: d.cls, constName: classHosts.get(d.cls)!.constName, method: verb, line: at, ...f });
            }
            // every fetch site of a class, host constant or not: a `<path>::<Class>`
            // declaration hangs its edges on these when nothing was detected
            if (d.cls) {
              const key = `${file}::${d.cls}`;
              classFetchSites.set(key, [...(classFetchSites.get(key) ?? []), { fromId, method: verb, line: at }]);
            }
            return;
          }
          // db.<table>.<op>() — keep the query code on the edge; code is the source of truth
          if (chain.length === 3 && chain[0] === 'db') {
            const [, table, op] = chain;
            const tableId = `${repo}::table::${table}`;
            addNode({ id: tableId, kind: 'table', name: table!, tags: autoTags('', table!, 'table') });
            const code = sourceSlice(source, b).replace(/\s+/g, ' ').slice(0, 200);
            const at = line(b.start ?? 0);
            if (WRITE_OPS.has(op!)) addEdge('writes', fromId, tableId, withFlags({ op: op!, code, line: at }, f), DB_BUILDER());
            else if (READ_OPS.has(op!)) addEdge('reads', fromId, tableId, withFlags({ op: op!, code, line: at }, f), DB_BUILDER());
            return;
          }
          // db.query.<table>.<op>() — Drizzle relational API
          if (chain.length === 4 && chain[0] === 'db' && chain[1] === 'query') {
            const [, , table, op] = chain;
            if (READ_OPS.has(op!) || WRITE_OPS.has(op!)) {
              pendingDbOps.push({ fromId, file, tableName: table!, op: op!, write: WRITE_OPS.has(op!), code: queryCode(), line: line(b.start ?? 0), ...f });
            }
            return;
          }
          // db.insert(claims).values(…) / db.update(claims).set(…) / db.delete(claims)
          // — Drizzle builder: the table is the identifier argument
          if (chain.length === 2 && chain[0] === 'db' && WRITE_OPS.has(chain[1]!)) {
            const t = args[0];
            if (isNode(t) && t.type === 'Identifier') {
              pendingDbOps.push({ fromId, file, tableName: String(t.name), op: chain[1]!, write: true, code: queryCode(), line: line(b.start ?? 0), ...f });
            }
            return;
          }
          // db.select(…).from(claims) — reads via the builder
          if (isNode(b.callee) && (b.callee.type === 'MemberExpression' || b.callee.type === 'StaticMemberExpression')) {
            const prop = b.callee.property as AstNode | undefined;
            const obj = b.callee.object as AstNode | undefined;
            if (prop?.name === 'from' && isNode(obj) && obj.type === 'CallExpression' && memberChain(obj.callee)[0] === 'db') {
              const t = args[0];
              if (isNode(t) && t.type === 'Identifier') {
                pendingDbOps.push({ fromId, file, tableName: String(t.name), op: 'select', write: false, code: queryCode(), line: line(b.start ?? 0), ...f });
                return;
              }
            }
          }
          // publish('topic', ...)
          if (chain.length === 1 && chain[0] === 'publish') {
            const topic = stringValue(args[0]);
            if (topic) {
              const qId = `${repo}::queue::${topic}`;
              addNode({ id: qId, kind: 'queue', name: topic, tags: autoTags('', topic, 'queue') });
              addEdge('publishes', fromId, qId, withFlags(undefined, f));
            }
            return;
          }
          // queue.sendMessage(…) / queue.receiveMessages(…) on a client bound above
          if (chain.length === 2 && queueVars.has(chain[0]!) && (chain[1] === 'sendMessage' || chain[1] === 'receiveMessages')) {
            pendingQueueOps.push({ fromId, file, queue: queueVars.get(chain[0]!)!, kind: chain[1] === 'sendMessage' ? 'publishes' : 'consumes', line: line(b.start ?? 0), ...f });
            return;
          }
          // this.method() inside a class — the sibling method in the same file
          if (chain.length === 2 && chain[0] === 'this' && d.cls) {
            pendingCalls.push({ fromId, file, callee: `${d.cls}.${chain[1]}`, line: line(b.start ?? 0), ...f });
            return;
          }
          // this.<field>.<…>.<fn>() inside a class — a field whose type is declared is
          // followed to the classes that implement it (01 §2.3.5); otherwise it is a
          // callback the constructor was handed, and pass 2 matches it against a
          // `new Class({ … })` binding. Optional chains are transparent: oxc wraps `?.` in a
          // ChainExpression around an ordinary CallExpression, which walk() reaches.
          if (chain.length >= 3 && chain[0] === 'this' && d.cls) {
            const hook = { fromId, file, cls: d.cls, path: chain.slice(1), line: line(b.start ?? 0), ...f };
            const rootType = fieldTypes.get(d.cls)?.get(chain[1]!);
            if (rootType) {
              pendingTypedCalls.push({ fromId, file, root: rootType, path: chain.slice(2, -1), method: chain[chain.length - 1]!,
                line: line(b.start ?? 0), ...f, fallback: { kind: 'hook', cls: d.cls, path: chain.slice(1) } });
            } else pendingHookCalls.push(hook);
            return;
          }
          // plain calls to local/imported symbols
          if (chain.length === 1 && /^[a-zA-Z_$]/.test(chain[0]!)) {
            pendingCalls.push({ fromId, file, callee: chain[0]!, line: line(b.start ?? 0), ...f });
          }
          // a.b.method(…) — when the receiver's type is declared, pass 2 follows the type
          // to its production implementers, whatever the method is called: a typed receiver
          // is never a runtime array or map, so the built-in filter does not apply to it
          // (01 §2.3.5, and §0.1 — that filter is why `Notifier.send` had no callers).
          // Untyped, it is resolved by method name to the one class that declares it
          // (repos.invoices.createDraft → PgInvoiceRepository.createDraft).
          const tail = chain[chain.length - 1];
          if (chain.length >= 2 && chain[0] !== 'this' && chain[0] !== 'db' && tail && /^[a-zA-Z_$]/.test(tail)) {
            const rootType = paramTypes.get(chain[0]!);
            if (rootType) {
              pendingTypedCalls.push({ fromId, file, root: rootType, path: chain.slice(1, -1), method: tail, line: line(b.start ?? 0), ...f,
                fallback: { kind: 'method', receiver: chain[chain.length - 2]! } });
            } else if (!BUILTIN_METHODS.has(tail)) {
              pendingMethodCalls.push({ fromId, file, method: tail, receiver: chain[chain.length - 2]!, line: line(b.start ?? 0), ...f });
            }
          }
          // schema.parse / schema.safeParse → validates
          if (chain.length === 2 && (chain[1] === 'parse' || chain[1] === 'safeParse')) {
            pendingCalls.push({ fromId, file, callee: chain[0]!, line: line(b.start ?? 0), ...f });
          }
        });
      };

      /**
       * `{ hooks: { invoiceCreated: async () => … } }` inside a declared function:
       * a `function` node `<host>.<key path>` tagged `callback`, a `deferred` calls
       * edge from the host, a hook binding when the literal is `new K({ … })`'s first
       * argument, and its own body walk. Returns false when the key path is not
       * plain (a computed key, an array in the way) — the site then stays the host's
       * with `deferred` from the ancestor scan.
       */
      function hoistCallback(fn: AstNode, prop: AstNode, parents: AstNode[], fromId: string, hostPath: string, hostGroup?: string): boolean {
        const keys: string[] = [];
        let i = parents.length - 1;
        let obj: AstNode | undefined;
        let objIdx = -1;
        for (;;) {
          const p = parents[i];
          if (!p || p.type !== 'Property') return false;
          const k = p.key as AstNode | undefined;
          const keyName = k && (typeof k.name === 'string' ? k.name : typeof k.value === 'string' ? k.value : null);
          if (!keyName) return false; // a computed key names nothing a reader could follow
          keys.unshift(keyName);
          const o = parents[i - 1];
          if (!o || o.type !== 'ObjectExpression') return false;
          const up = parents[i - 2];
          if (up && up.type === 'Property' && up.value === o) { i -= 2; continue; }
          obj = o; objIdx = i - 1;
          break;
        }
        const cbPath = `${hostPath}.${keys.join('.')}`;
        const cbId = symbolId(file, cbPath);
        const cbName = keys[keys.length - 1]!;
        const cbBody = (fn.body as AstNode) ?? null;
        // the binding is recorded even when the node already exists (two `new K({…})` of the same shape)
        const outer = objIdx > 0 ? parents[objIdx - 1] : undefined;
        if (outer && outer.type === 'NewExpression' && isNode(outer.callee) && (outer.callee as AstNode).type === 'Identifier'
          && (((outer.arguments as AstNode[]) ?? [])[0] === obj)) {
          const cn = String((outer.callee as AstNode).name);
          hookBindings.push({ file, className: cn, classRef: importMap.get(cn) ?? { file, name: cn }, path: keys.join('.'), fnId: cbId, line: line(outer.start ?? 0) });
        }
        if (walkedCallbacks.has(cbId)) return true;
        walkedCallbacks.add(cbId);
        const cbDoc = parseDoc(leadingComment(source, prop.start ?? 0));
        const cbBranches = extractBranches(cbBody, source, line);
        addNode({
          id: cbId, kind: 'function', name: cbName, lang: langOf(file),
          loc: { repo, path: file, line: line(fn.start ?? 0), endLine: line(fn.end ?? 0) },
          docs: cbDoc.docs,
          snippet: snippetOf(source, fn),
          ...(cbBranches.length ? { branches: cbBranches } : {}),
          group: cbDoc.group ?? hostGroup,
          tags: [...autoTags(file, cbName, 'function'), 'callback', ...cbDoc.tags],
          ...(cbDoc.business ? { facets: { business: { description: cbDoc.business } } } : {}),
          ...docLinkFields(cbDoc),
        });
        // the host built it; it did not run it — journeys print the handover, not the work
        addEdge('calls', fromId, cbId, { deferred: true, line: line(fn.start ?? 0) });
        walkBody(cbBody, cbId, cbPath, cbDoc.group ?? hostGroup);
        return true;
      }

      walkBody(d.body, id, d.name, nodes.get(id)?.group);
    }

    // file-derived grouping: files with several functions collapse into one
    // group in the GUI unless the author set an explicit @group
    if (fileFunctionIds.length >= 4) {
      for (const fid of fileFunctionIds) {
        const n = nodes.get(fid)!;
        if (!n.group) n.group = file;
      }
    }

    // Next.js App Router: the file system is the router. page/route/layout
    // basenames under an app/ directory are entry-point conventions.
    const appMatch = file.match(/^(.*\/)?app\/(.+)$/);
    if (appMatch) {
      const appRoot = appMatch[1] ?? '';
      const rest = appMatch[2]!;
      const base = rest.split('/').pop()!;
      const dir = rest.slice(0, rest.length - base.length).replace(/\/$/, '');
      const routePath = appRoutePath(dir);
      if (/^page\.(tsx|jsx|ts|js)$/.test(base)) {
        const pageId = `${repo}::page::${routePath}`;
        addNode({
          id: pageId, kind: 'page', name: routePath, lang: langOf(file),
          loc: { repo, path: file, line: 1 },
          tags: autoTags(file, routePath, 'page'),
        });
        const comp = defaultExportName(program);
        if (comp) pendingRenders.push({ fromId: pageId, file, callee: comp, ...NO_FLAGS });
        appPages.push({ nodeId: pageId, appRoot, dir });
      } else if (/^route\.(ts|js)$/.test(base)) {
        // API route: one route node per exported HTTP-verb handler
        for (const d of declared) {
          if (!ROUTE_FILE_METHODS.has(d.name)) continue;
          const routeId = `${repo}::route::${d.name} ${routePath}`;
          addNode({
            id: routeId, kind: 'route', name: `${d.name} ${routePath}`, lang: langOf(file),
            loc: { repo, path: file, line: line(d.node.start ?? 0) },
            tags: autoTags(file, routePath, 'route'),
          });
          addEdge('calls', routeId, symbolId(file, d.name), undefined, bySymbol('same-file'));
          routeHandlers.push({ routeId, file, handler: d.name });
          appApiRoutes.push({ nodeId: routeId, appRoot, dir });
        }
      } else if (/^layout\.(tsx|jsx)$/.test(base)) {
        const comp = defaultExportName(program);
        if (comp) appLayouts.push({ fnId: symbolId(file, comp), appRoot, dir });
      }
    }
    // middleware.ts next to (or above) an app/ dir is the auth seam
    if (/(^|\/)middleware\.(ts|js)$/.test(file)) {
      middlewares.push({ file, prefix: file.replace(/middleware\.(ts|js)$/, '') });
    }

    // app routes (UI pages): React Router / Angular-style route configs
    walk(program, (n) => {
      // {path: '/invoices', element: <InvoiceListPage/>} or {path: 'x', component: XComponent}
      if (n.type === 'ObjectExpression') {
        const props: Record<string, AstNode> = {};
        for (const prop of (n.properties as AstNode[]) ?? []) {
          const key = prop.key as AstNode | undefined;
          const keyName = key && (key.name ?? key.value);
          if (typeof keyName === 'string' && isNode(prop.value)) props[keyName] = prop.value as AstNode;
        }
        const pathVal = props.path ? stringValue(props.path) : null;
        const target =
          (props.element && jsxName(props.element)) ||
          (props.component && props.component.type === 'Identifier' ? String(props.component.name) : null);
        if (pathVal !== null && target) {
          addPage(pathVal, target, line(n.start ?? 0));
        }
        return;
      }
      // <Route path="/invoices" element={<InvoiceListPage/>}/>
      if (n.type === 'JSXElement' && jsxName(n) === 'Route') {
        const attrs: Record<string, AstNode> = {};
        const opening = n.openingElement as AstNode;
        for (const attr of (opening.attributes as AstNode[]) ?? []) {
          if (attr.type !== 'JSXAttribute') continue;
          const attrName = (attr.name as AstNode | undefined)?.name;
          if (typeof attrName === 'string' && isNode(attr.value)) attrs[attrName] = attr.value as AstNode;
        }
        const pathVal = attrs.path ? stringValue(attrs.path) : null;
        const container = attrs.element && attrs.element.type === 'JSXExpressionContainer' ? (attrs.element.expression as AstNode) : attrs.element;
        const target = container ? jsxName(container) : null;
        if (pathVal !== null && target) addPage(pathVal, target, line(n.start ?? 0));
        return;
      }
    });

    function addPage(pagePath: string, componentName: string, atLine: number) {
      const name = pagePath.startsWith('/') ? pagePath : '/' + pagePath;
      const pageId = `${repo}::page::${name}`;
      addNode({
        id: pageId, kind: 'page', name, lang: langOf(file),
        loc: { repo, path: file, line: atLine },
        tags: autoTags(file, name, 'page'),
      });
      pendingRenders.push({ fromId: pageId, file, callee: componentName, line: atLine, ...NO_FLAGS });
    }

    // raw node:http servers — createServer((req, res) => { if (url.pathname === '/x' && req.method === 'POST') … }):
    // one route per literal path comparison (=== / startsWith) against req.url /
    // url / url.pathname; the method comes from a sibling `req.method === 'X'`
    // test in the same if, else GET. Calls inside the matching branch belong
    // to the route (it has no handler function of its own), like inline
    // Express handlers. Farsight's own server and the reference app's inspection server
    // are this shape.
    const urlish = (chain: string[]) => chain.length > 0 && ['url', 'pathname'].includes(chain[chain.length - 1]!);
    walk(program, (n) => {
      if (n.type !== 'CallExpression' || memberChain(n.callee).pop() !== 'createServer') return;
      const cb = ((n.arguments as AstNode[]) ?? []).find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression');
      if (!cb) return false;
      walk(cb.body, (b, parents) => {
        let path: string | null = null;
        if (b.type === 'BinaryExpression' && (b.operator === '===' || b.operator === '==')) {
          const l = b.left as AstNode, r = b.right as AstNode;
          const lit = stringValue(r) ?? stringValue(l);
          const other = stringValue(r) != null ? l : r;
          if (lit && lit.startsWith('/') && urlish(memberChain(other))) path = lit;
        } else if (b.type === 'CallExpression') {
          const c = memberChain(b.callee);
          if (c[c.length - 1] === 'startsWith' && urlish(c.slice(0, -1))) {
            const lit = stringValue(((b.arguments as AstNode[]) ?? [])[0]);
            if (lit && lit.startsWith('/')) path = lit;
          }
        }
        if (!path) return;
        const ifStmt = [...parents].reverse().find((p) => p.type === 'IfStatement');
        let method = 'GET';
        if (ifStmt) walk(ifStmt.test, (m) => {
          if (m.type !== 'BinaryExpression') return;
          const v = stringValue(m.right) ?? stringValue(m.left);
          const side = stringValue(m.right) != null ? m.left : m.right;
          if (v && memberChain(side).pop() === 'method' && ROUTE_FILE_METHODS.has(v.toUpperCase())) method = v.toUpperCase();
        });
        const routeId = `${repo}::route::${method} ${path}`;
        if (nodes.has(routeId)) return false;
        addNode({
          id: routeId, kind: 'route', name: `${method} ${path}`, lang: langOf(file),
          loc: { repo, path: file, line: line(b.start ?? 0) },
          tags: [...autoTags(file, path, 'route'), 'http-server'],
        });
        if (ifStmt) walk(ifStmt.consequent, (c, cps) => {
          if (c.type !== 'CallExpression') return;
          const cc = memberChain(c.callee);
          if (cc.length === 1 && /^[a-z_$]/i.test(cc[0]!)) pendingCalls.push({ fromId: routeId, file, callee: cc[0]!, line: line(c.start ?? 0), ...scanAncestors(cps) });
        });
        return false;
      });
      return false;
    });

    // routes: router.post('/path', mw..., handler) at any nesting
    walk(program, (n) => {
      if (n.type !== 'CallExpression') return;
      const chain = memberChain(n.callee);
      if (chain.length !== 2 || !ROUTER_NAMES.has(chain[0]!) || !HTTP_METHODS.has(chain[1]!)) return;
      const args = (n.arguments as AstNode[]) ?? [];
      const path = stringValue(args[0]);
      if (!path) return;
      const method = chain[1]!.toUpperCase();
      const routeId = `${repo}::route::${method} ${path}`;
      addNode({
        id: routeId, kind: 'route', name: `${method} ${path}`, lang: langOf(file),
        loc: { repo, path: file, line: line(n.start ?? 0) },
        tags: autoTags(file, path, 'route'),
      });

      for (const arg of args.slice(1)) {
        // middleware: requireScope('billing:write') → guard node + edge
        if (arg.type === 'CallExpression') {
          const mwChain = memberChain(arg.callee);
          const mwArg = stringValue(((arg.arguments as AstNode[]) ?? [])[0]);
          if (mwChain.length === 1 && /^(require|ensure|check|assert)/i.test(mwChain[0]!)) {
            const guardId = `${repo}::guard::${mwChain[0]}(${mwArg ?? ''})`;
            addNode({
              id: guardId, kind: 'guard', name: mwArg ? `${mwChain[0]}: ${mwArg}` : mwChain[0]!,
              tags: ['auth'], loc: { repo, path: file, line: line(arg.start ?? 0) },
            });
            addEdge('guards', guardId, routeId, undefined, {
              status: 'heuristic', technique: 'detected', confidence: 'MEDIUM',
              note: `a route argument named ${mwChain[0]} — nobody declared it a guard`,
            });
          }
        }
        // handler body: calls + schema validates from inside the route handler
        if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
          // inline handler forks belong to the route node (it has no function node of its own)
          const handlerBranches = extractBranches((arg.body as AstNode) ?? null, source, line);
          if (handlerBranches.length) {
            const rn = nodes.get(routeId)!;
            rn.branches = [...(rn.branches ?? []), ...handlerBranches].slice(0, MAX_BRANCH_POINTS);
          }
          // the handler is a call argument, never deferred; a withTx(…) inside it still counts
          walk(arg.body, (b, hps) => {
            if (b.type !== 'CallExpression') return;
            const c = memberChain(b.callee);
            const hf = scanAncestors(hps);
            if (c.length === 1 && /^[a-z_$]/i.test(c[0]!)) pendingCalls.push({ fromId: routeId, file, callee: c[0]!, line: line(b.start ?? 0), ...hf });
            if (c.length === 2 && (c[1] === 'parse' || c[1] === 'safeParse')) pendingCalls.push({ fromId: routeId, file, callee: c[0]!, line: line(b.start ?? 0), ...hf });
          });
        }
        // a bare identifier: middleware (requireAuth) or a named handler (createSession) —
        // pass 2's kind mapping tells them apart by what the name resolves to; recording it
        // as a route handler too lets a named handler's own guards/validates mirror onto the route
        if (arg.type === 'Identifier') {
          pendingCalls.push({ fromId: routeId, file, callee: String(arg.name), line: line(arg.start ?? 0), ...NO_FLAGS });
          routeHandlers.push({ routeId, file, handler: String(arg.name) });
        }
      }
      return false;
    });
  }

  // the `??=` heuristic's builders: tag them now that every declaration is a node.
  // `applySetupOrigin` (core) grows the closure from these roots and stamps the edges.
  for (const id of pendingSetupTags) {
    const n = nodes.get(id);
    if (!n || n.kind !== 'function' || n.tags.includes('setup')) continue;
    n.tags.push('setup');
  }

  // ── App Router stitching ─────────────────────────────────────────
  // layouts wrap every page beneath their directory
  for (const l of appLayouts) {
    if (!nodes.has(l.fnId)) continue;
    for (const p of appPages) {
      if (p.appRoot !== l.appRoot) continue;
      if (l.dir && p.dir !== l.dir && !p.dir.startsWith(l.dir + '/')) continue;
      addEdge('renders', l.fnId, p.nodeId);
    }
  }
  // middleware guards every app entry under its directory (Next's default
  // matcher runs on all routes; matcher narrowing is a future refinement)
  for (const mw of middlewares) {
    const targets = [...appPages, ...appApiRoutes].filter((t) => t.appRoot.startsWith(mw.prefix));
    if (!targets.length) continue;
    const guardId = `${repo}::guard::middleware:${mw.file}`;
    addNode({
      id: guardId, kind: 'guard', name: 'middleware', tags: ['auth'],
      loc: { repo, path: mw.file, line: 1 },
    });
    for (const t of targets) addEdge('guards', guardId, t.nodeId, undefined, {
      status: 'heuristic', technique: 'detected', confidence: 'MEDIUM',
      note: `middleware.ts under ${mw.prefix || 'the repo root'}; the file's own matcher is not read, so this is every entry beneath it`,
    });
  }

  // ── pass 2: resolve calls via same-file symbols then imports ────
  const byFileAndName = new Map<string, string>();
  for (const s of symbols) byFileAndName.set(`${s.file}::${s.name}`, s.nodeId);
  for (const [id] of nodes) {
    // rule nodes are addressable too (schema validates edges)
    const parts = id.split('::');
    if (parts.length === 3) byFileAndName.set(`${parts[1]}::${parts[2]}`, id);
  }

  const seenEdge = new Set<string>();
  // follow a name through barrel files: declared here, or re-exported (star/named) from elsewhere
  const lookupExport = (file: string, name: string, seen: Set<string>): string | undefined => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    const direct = byFileAndName.get(`${file}::${name}`);
    if (direct) return direct;
    const re = reexportsByFile.get(file);
    if (!re) return undefined;
    const named = re.named.get(name);
    if (named) return lookupExport(named.file, named.name, seen);
    for (const star of re.stars) {
      const hit = lookupExport(star, name, seen);
      if (hit) return hit;
    }
    return undefined;
  };
  /** The node a name refers to, and which of the two routes found it (B5.1). */
  const resolveVia = (file: string, name: string): { id: string; via: 'same-file' | 'static-import' } | undefined => {
    const direct = byFileAndName.get(`${file}::${name}`);
    if (direct) return { id: direct, via: 'same-file' };
    const imp = importsByFile.get(file)?.get(name);
    if (!imp) return undefined;
    const id = lookupExport(imp.file, imp.name, new Set());
    return id ? { id, via: 'static-import' } : undefined;
  };
  const resolveTarget = (file: string, name: string): string | undefined => resolveVia(file, name)?.id;
  for (const call of pendingCalls) {
    const hit = resolveVia(call.file, call.callee);
    const targetId = hit?.id;
    if (!targetId || targetId === call.fromId) continue;
    const target = nodes.get(targetId);
    const kind: GraphEdge['kind'] =
      target?.kind === 'rule' ? 'validates' : target?.kind === 'guard' ? 'guards' : 'calls';
    const key = `${kind}|${call.fromId}|${targetId}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    // the resolution names the fact that makes the edge what it is. For calls and
    // validates that is how the name resolved; for a guards edge it is the `@guard`
    // that turned a function into a gate — both facts are HIGH, and the route the
    // name took is kept in the note so neither is lost.
    const byName = bySymbol(hit.via);
    const res: GraphEdge['resolution'] = kind === 'guards'
      ? { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH',
          note: `@guard on ${target?.name ?? call.callee}, ${hit.via === 'same-file' ? 'declared in the same file' : 'imported here'}` }
      : byName;
    // rules validate and guards guard their caller — the edge points back at it
    if (kind === 'validates' || kind === 'guards') addEdge(kind, targetId, call.fromId, withFlags(undefined, call), res);
    else addEdge(kind, call.fromId, targetId, withFlags(call.line != null ? { line: call.line } : undefined, call), res);
    // a @guard function with a body of its own is also RUN by its caller: the gate is a badge on the
    // route, the transaction inside it (submitDraftInvoice writes lines, mints the token, enqueues
    // the ERP draft) is a step — keep the calls edge so journeys descend into it
    if (kind === 'guards' && target?.loc && target.snippet) {
      const ck = `calls|${call.fromId}|${targetId}`;
      if (!seenEdge.has(ck)) { seenEdge.add(ck); addEdge('calls', call.fromId, targetId, withFlags({ via: 'guard', ...(call.line != null ? { line: call.line } : {}) }, call), byName); }
    }
  }
  // a route that delegates to a named handler inherits the handler's gates and rules —
  // exactly one hop, so a guard two calls deep inside a shared service stays off the route
  for (const rh of routeHandlers) {
    const handlerId = resolveTarget(rh.file, rh.handler);
    if (!handlerId || !nodes.has(rh.routeId)) continue;
    for (const e of [...edges].filter((e) => e.to === handlerId && (e.kind === 'guards' || e.kind === 'validates'))) {
      const key = `${e.kind}|${e.from}|${rh.routeId}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      addEdge(e.kind, e.from, rh.routeId, { via: 'handler', handler: handlerId });
    }
  }
  for (const r of pendingRenders) {
    const targetId = resolveTarget(r.file, r.callee);
    if (!targetId || targetId === r.fromId) continue;
    if (nodes.get(targetId)?.kind !== 'component') continue;
    const key = `renders|${r.fromId}|${targetId}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    addEdge('renders', r.fromId, targetId, withFlags(r.line != null ? { line: r.line } : undefined, r),
      r.jsx ? { status: 'resolved', technique: 'jsx-render', confidence: 'HIGH', note: `<${r.callee}> is written in this body` } : undefined);
  }

  // Drizzle ops: resolve the table identifier through imports/barrels to the
  // pgTable-declared node; fall back to a bare table node named by the variable
  for (const dop of pendingDbOps) {
    // a SQL statement names the table itself — no identifier to resolve
    let tableId = dop.sql ? undefined : resolveTarget(dop.file, dop.tableName);
    if (!tableId || nodes.get(tableId)?.kind !== 'table') {
      tableId = `${repo}::table::${dop.tableName}`;
      addNode({ id: tableId, kind: 'table', name: dop.tableName, tags: autoTags('', dop.tableName, 'table') });
    }
    const key = `${dop.write ? 'writes' : 'reads'}|${dop.fromId}|${tableId}|${dop.op}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    addEdge(dop.write ? 'writes' : 'reads', dop.fromId, tableId, withFlags({ op: dop.op, code: dop.code, ...(dop.line != null ? { line: dop.line } : {}) }, dop),
      dop.sql ? RAW_SQL() : DB_BUILDER());
  }

  // ── typed dispatch: the receiver's declared type, not its name (01 §2.3.5) ───────
  // `n.send(…)` where `n: Notifier` reaches the classes that promise to be a Notifier —
  // the class itself, whoever `implements` it, or (only when no one declares either) a
  // class named for it. Test doubles step aside but are always printed as `alternatives`;
  // several production implementers mean several edges, never a pick. A type nothing
  // implements is an absence with a name on it, not a guess by method name.
  const lookupType = (file: string, name: string, seen: Set<string>): TypeDecl | undefined => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    const direct = typesByFile.get(file)?.get(name);
    if (direct) return direct;
    const imp = importsByFile.get(file)?.get(name);
    if (imp) { const hit = lookupType(imp.file, imp.name, seen); if (hit) return hit; }
    const re = reexportsByFile.get(file);
    if (!re) return undefined;
    const named = re.named.get(name);
    if (named) { const hit = lookupType(named.file, named.name, seen); if (hit) return hit; }
    for (const star of re.stars) { const hit = lookupType(star, name, seen); if (hit) return hit; }
    return undefined;
  };
  /**
   * The declaration a receiver's type ends at, walking the property path one hop at a
   * time. An inline object literal is a path, never a destination: a call on one is left
   * to the name rules, because nothing can implement an anonymous shape.
   */
  const resolveTypeRef = (file: string, root: TypeRef, path: string[]): TypeDecl | undefined => {
    let curFile = file;
    let cur = root;
    for (const seg of path) {
      let props: Map<string, TypeRef>;
      if ('literal' in cur) props = cur.literal;
      else {
        const decl = lookupType(curFile, cur.name, new Set());
        if (!decl) return undefined;
        curFile = decl.file;
        props = decl.props;
      }
      const next = props.get(seg);
      if (!next) return undefined;
      cur = next;
    }
    return 'literal' in cur ? undefined : lookupType(curFile, cur.name, new Set());
  };
  // every class that says `implements T`, indexed by the declaration it resolves to —
  // by name alone when the implemented name resolves to nothing this ingest saw
  const implementers = new Map<string, { cls: string; file: string }[]>();
  for (const [file, declsHere] of typesByFile) {
    for (const decl of declsHere.values()) {
      if (decl.kind !== 'class') continue;
      for (const iname of decl.implements) {
        const t = lookupType(file, iname, new Set());
        const key = t ? `${t.file}::${t.name}` : iname;
        implementers.set(key, [...(implementers.get(key) ?? []), { cls: decl.name, file: decl.file }]);
      }
    }
  }
  for (const tc of pendingTypedCalls) {
    const T = resolveTypeRef(tc.file, tc.root, tc.path);
    if (!T) {
      // the annotation named no declaration this ingest saw, or it ended in an anonymous
      // shape: the call goes back to the rule it would have followed without a type
      if (tc.fallback.kind === 'hook') {
        pendingHookCalls.push({ fromId: tc.fromId, file: tc.file, cls: tc.fallback.cls, path: tc.fallback.path, line: tc.line, deferred: tc.deferred, tx: tc.tx });
      } else if (!BUILTIN_METHODS.has(tc.method)) {
        pendingMethodCalls.push({ fromId: tc.fromId, file: tc.file, method: tc.method, receiver: tc.fallback.receiver, line: tc.line, deferred: tc.deferred, tx: tc.tx });
      }
      continue;
    }
    const classes: { cls: string; file: string }[] = T.kind === 'class' ? [{ cls: T.name, file: T.file }] : [];
    classes.push(...(implementers.get(`${T.file}::${T.name}`) ?? []), ...(implementers.get(T.name) ?? []));
    // the structural fallback, and only when no one declared themselves: a class named
    // for the interface (PgAuditRepository for AuditRepository) that declares the method
    const impl = classes.length
      ? classes.flatMap((c) => (methodIndex.get(tc.method) ?? []).filter((m) => m.cls === c.cls && m.file === c.file))
      : (methodIndex.get(tc.method) ?? []).filter((m) => m.cls !== T.name && m.cls.endsWith(T.name));
    const seenImpl = new Set<string>();
    const all = impl.filter((m) => {
      if (seenImpl.has(m.nodeId)) return false;
      seenImpl.add(m.nodeId);
      return true;
    });
    if (!all.length) {
      // a `this.<field>.<path>.fn()` chain whose named type nothing implements is a callback
      // slot (the reference app: `deps.hooks?: BcOutboxHooks`), not a service: the binding written at
      // `new K({ hooks: { fn } })` is the fact to follow, and only when none exists is the
      // absence tagged on the caller
      if (tc.fallback.kind === 'hook') {
        pendingHookCalls.push({ fromId: tc.fromId, file: tc.file, cls: tc.fallback.cls, path: tc.fallback.path, line: tc.line, deferred: tc.deferred, tx: tc.tx, tagIfUnbound: true });
        continue;
      }
      // nothing implements the type this build can see: the caller says so, and no edge
      // is invented from the method's name (the ambiguity the type was there to remove)
      const caller = nodes.get(tc.fromId);
      if (caller && !caller.tags.includes('unresolved:interface')) caller.tags.push('unresolved:interface');
      continue;
    }
    const production = all.filter((m) => !TEST_DOUBLE.test(m.cls) && !TEST_DOUBLE.test(m.file));
    const pool = production.length ? production : all;
    const note = T.kind === 'class' && all.length === 1
      ? `the receiver is declared as the class ${T.name}`
      : all.length === 1
        ? `the only implementer of ${T.name} that declares ${tc.method}`
        : `${all.length} classes implement ${T.name}; ${production.length < all.length ? 'in-memory / mock twins set aside' : 'every production implementer is drawn'}`;
    for (const target of pool) {
      if (target.nodeId === tc.fromId) continue;
      const key = `calls|${tc.fromId}|${target.nodeId}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      const alternatives = all.filter((m) => m.nodeId !== target.nodeId).map((m) => m.nodeId);
      edges.push({
        id: `e${edgeSeq++}`, kind: 'calls', from: tc.fromId, to: target.nodeId,
        meta: withFlags({ line: tc.line ?? 0, via: 'interface', iface: T.name }, tc),
        resolution: {
          status: 'heuristic', technique: 'interface', confidence: 'MEDIUM',
          ...(alternatives.length ? { alternatives } : {}), note,
        },
      });
    }
  }

  // member calls by method name: `repos.invoices.createDraft(…)` reaches the one class
  // method of that name; a mock / in-memory twin steps aside for its production class;
  // when the receiver's word picks one of several (invoices → InvoiceRepository) it wins;
  // anything still ambiguous stays an honest absence rather than a wrong edge
  const singular = (w: string) => w.toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
  for (const mc of pendingMethodCalls) {
    const cands = (methodIndex.get(mc.method) ?? []).filter((c) => c.nodeId !== mc.fromId);
    if (!cands.length) continue;
    const real = cands.filter((c) => !TEST_DOUBLE.test(c.cls) && !TEST_DOUBLE.test(c.file));
    let pool = real.length ? real : cands;
    if (pool.length > 1) {
      const byRecv = pool.filter((c) => c.cls.toLowerCase().includes(singular(mc.receiver)));
      if (byRecv.length === 1) pool = byRecv;
    }
    if (pool.length !== 1) continue;
    const target = pool[0]!;
    const key = `calls|${mc.fromId}|${target.nodeId}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    const note = cands.length === 1
      ? `the only class method named ${mc.method}`
      : `${cands.length} classes declare ${mc.method}; ${real.length < cands.length ? 'in-memory / mock twins set aside' : `${mc.receiver} picked ${target.cls}`}`;
    edges.push({ id: `e${edgeSeq++}`, kind: 'calls', from: mc.fromId, to: target.nodeId, meta: withFlags({ line: mc.line ?? 0, via: 'method-name' }, mc),
      resolution: { status: 'heuristic', technique: 'method-name', confidence: 'MEDIUM', note } });
  }

  // callbacks handed to a constructor: `this.deps.hooks?.invoiceCreated?.()` in a class
  // method reaches the function expression bound at `new BcOutboxWorker({ hooks: { … } })`.
  // Heuristic and always deferred — the constructor stored it, the method runs it later.
  // An unmatched hook call stays an honest absence rather than an invented edge.
  const lookupClass = (file: string, name: string, seen: Set<string>): string | undefined => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    if (classDecls.has(`${file}::${name}`)) return file;
    const re = reexportsByFile.get(file);
    if (!re) return undefined;
    const named = re.named.get(name);
    if (named) return lookupClass(named.file, named.name, seen);
    for (const star of re.stars) { const hit = lookupClass(star, name, seen); if (hit) return hit; }
    return undefined;
  };
  for (const hk of pendingHookCalls) {
    let bound = false;
    const full = hk.path.join('.');
    // `constructor(private readonly deps: { hooks })` — the field name is not part of the literal's path
    const dropped = hk.path.slice(1).join('.');
    for (const b of hookBindings) {
      if (b.classRef.name !== hk.cls) continue;
      if (b.path !== full && b.path !== dropped) continue;
      if (lookupClass(b.classRef.file, b.classRef.name, new Set()) !== hk.file) continue;
      const key = `calls|${hk.fromId}|${b.fnId}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ id: `e${edgeSeq++}`, kind: 'calls', from: hk.fromId, to: b.fnId,
        meta: { line: hk.line ?? 0, via: 'hook', deferred: true, ...(hk.tx ? { tx: true } : {}) },
        resolution: { status: 'heuristic', technique: 'hook-binding', confidence: 'MEDIUM',
          note: `bound at ${b.file}:${b.line} of new ${b.className}({…})` } });
      bound = true;
    }
    if (!bound && hk.tagIfUnbound) {
      const caller = nodes.get(hk.fromId);
      if (caller && !caller.tags.includes('unresolved:interface')) caller.tags.push('unresolved:interface');
    }
  }

  // queue clients: the name travels as a constant — this file, or an import followed through barrels
  const lookupConst = (file: string, name: string, seen: Set<string>): string | undefined => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    const direct = constStrings.get(`${file}::${name}`);
    if (direct) return direct;
    const imp = importsByFile.get(file)?.get(name);
    if (imp) { const hit = lookupConst(imp.file, imp.name, seen); if (hit) return hit; }
    const re = reexportsByFile.get(file);
    if (!re) return undefined;
    const named = re.named.get(name);
    if (named) return lookupConst(named.file, named.name, seen);
    for (const star of re.stars) { const hit = lookupConst(star, name, seen); if (hit) return hit; }
    return undefined;
  };
  for (const qo of pendingQueueOps) {
    const name = qo.queue.literal ?? (qo.queue.ref ? lookupConst(qo.file, qo.queue.ref, new Set()) ?? qo.queue.ref : undefined);
    if (!name) continue;
    const qId = `${repo}::queue::${name}`;
    addNode({ id: qId, kind: 'queue', name, tags: autoTags('', name, 'queue') });
    const key = `${qo.kind}|${qo.fromId}|${qId}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    if (qo.kind === 'publishes') addEdge('publishes', qo.fromId, qId, withFlags({ line: qo.line ?? 0 }, qo));
    else addEdge('consumes', qId, qo.fromId, withFlags({ line: qo.line ?? 0 }, qo));
  }

  // ── pass 3: stitch fetch() call sites to routes ─────────────────
  // Unmatched calls are never dropped: another host → an `external` node
  // named by host; a relative path no local route serves → an `unknown` "?"
  // stub that core/stitch.ts re-points when another source (code or spec)
  // declares the route. Every http edge carries its resolution.
  const routes = [...nodes.values()].filter((n) => n.kind === 'route');
  for (const hc of httpCalls) {
    const meta = withFlags({ method: hc.method, path: hc.path, ...(hc.line != null ? { line: hc.line } : {}) }, hc)!;
    const abs = hc.path.match(/^(https?:\/\/[^/]+)(\/.*)?$/);
    if (abs) {
      const host = abs[1]!.replace(/^https?:\/\//, '');
      const extId = `${repo}::external::${host}`;
      addNode({ id: extId, kind: 'external', name: host, tags: ['http', 'external'] });
      edges.push({ id: `e${edgeSeq++}`, kind: 'http', from: hc.fromId, to: extId, meta: { ...meta, path: abs[2] ?? '/' },
        resolution: { status: 'resolved', technique: 'fetch→route', confidence: 'HIGH', note: 'call to another host' } });
      continue;
    }
    // a templated host (`${base}/x`) normalizes to a leading `:param` — match it as a host wildcard
    const hostless = hc.path.startsWith(':param/') ? hc.path.slice(':param'.length) : null;
    const match = routes.find((r) => {
      // a 'use server' action is a route node named for the function — no method/path to match
      const [m, p] = r.name.split(' ');
      if (!p) return false;
      const np = normalizePath(p);
      return m === hc.method && (np === hc.path || (hostless != null && np === hostless));
    });
    if (match) {
      edges.push({ id: `e${edgeSeq++}`, kind: 'http', from: hc.fromId, to: match.id, meta,
        resolution: { status: 'resolved', technique: 'fetch→route', confidence: 'HIGH' } });
      continue;
    }
    const stubId = `${repo}::unknown::${hc.method} ${hc.path}`;
    addNode({ id: stubId, kind: 'unknown', name: `${hc.method} ${hc.path}`, tags: ['http', 'unresolved'] });
    edges.push({ id: `e${edgeSeq++}`, kind: 'http', from: hc.fromId, to: stubId, meta,
      resolution: { status: 'unresolved', technique: 'fetch→route', confidence: 'LOW', candidates: [], note: 'no indexed route serves this path' } });
  }

  // ── externals: three sources, one node (01 §2.3.4) ───────────────
  // An external is only ever created because an edge reaches it — a recognised but
  // unused SDK import, an unresolvable host constant and a declared class with no
  // `fetch` all leave nothing behind rather than inventing a system.
  /** The node for one third-party system, merging provenance onto whatever is already there. */
  const externalNodeFor = (name: string, ref: ExternalRef): string => {
    const id = `${repo}::external::${name}`;
    const existing = nodes.get(id);
    if (existing) {
      // an absolute-literal `fetch` to the same host may have made this node already:
      // one system is one node, so the provenance merges instead of forking it
      if (!existing.external) existing.external = ref;
      for (const t of ['external', ref.kind]) if (!existing.tags.includes(t)) existing.tags.push(t);
      return id;
    }
    addNode({ id, kind: 'external', name, tags: ['external', ref.kind], external: ref });
    return id;
  };
  const externalEdge = (fromId: string, extId: string, meta: GraphEdge['meta'], resolution: GraphEdge['resolution']) => {
    const key = `http|${fromId}|${extId}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ id: `e${edgeSeq++}`, kind: 'http', from: fromId, to: extId, meta, ...(resolution ? { resolution } : {}) });
  };
  // a `<path>::<Class>` declaration renames and re-kinds what was detected through that class
  const declaredFor = (file: string, cls?: string) => (cls ? declaredClassExternals.get(`${file}::${cls}`) : undefined);
  const usedDeclarations = new Set<string>();

  for (const use of sdkUses) {
    const decl = declaredFor(use.file, use.via);
    if (decl && use.via) usedDeclarations.add(`${use.file}::${use.via}`);
    const extId = externalNodeFor(decl?.name ?? use.name, {
      kind: decl?.kind ?? use.kind, source: decl ? 'config' : 'sdk', ...(use.via ? { via: use.via } : {}), ref: use.specifier,
    });
    externalEdge(use.fromId, extId, { via: 'sdk', ...(use.line != null ? { line: use.line } : {}) },
      { status: 'heuristic', technique: 'sdk-import', confidence: 'MEDIUM', note: `uses ${use.specifier} in ${use.file}` });
  }

  for (const hostCall of pendingHostCalls) {
    const value = lookupConst(hostCall.file, hostCall.constName, new Set());
    const host = value ? hostOf(value) : null;
    if (!host) continue; // the constant could not be followed to a host: an absence, not a guess
    const decl = declaredFor(hostCall.file, hostCall.cls);
    if (decl) usedDeclarations.add(`${hostCall.file}::${hostCall.cls}`);
    const extId = externalNodeFor(decl?.name ?? host, {
      kind: decl?.kind ?? 'http', source: decl ? 'config' : 'host', via: hostCall.cls, ref: hostCall.constName,
    });
    externalEdge(hostCall.fromId, extId,
      withFlags({ method: hostCall.method, via: 'host', ...(hostCall.line != null ? { line: hostCall.line } : {}) }, hostCall),
      { status: 'heuristic', technique: 'constant-host', confidence: 'MEDIUM', note: `base URL from ${hostCall.constName}` });
  }

  // a declaration nothing was detected for: the author says this class is the client, so
  // every `fetch` it makes reaches that system. A declared class with no `fetch` at all
  // gets no node — there is no call site to hang an edge on, and one is not invented.
  for (const [key, decl] of declaredClassExternals) {
    if (usedDeclarations.has(key)) continue;
    const sites = classFetchSites.get(key);
    if (!sites?.length) continue;
    const cls = key.slice(key.indexOf('::') + 2);
    const extId = externalNodeFor(decl.name, { kind: decl.kind, source: 'config', via: cls, ref: decl.import });
    for (const site of sites) {
      externalEdge(site.fromId, extId, { method: site.method, via: 'config', ...(site.line != null ? { line: site.line } : {}) },
        { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH', note: `declared in farsight.config.json → externals as ${decl.import}` });
    }
  }

  return { repo, nodes: [...nodes.values()], edges, meta };
}

// ── helpers ──────────────────────────────────────────────────────

/**
 * The type an annotation names (01 §2.3.5): a plain reference (`Notifier`) or an inline
 * object literal (`{ provider: Ocr }`), which is a path to walk and never a type anything
 * implements. A union, a generic, an array, `any` or a keyword names nothing here — the
 * call then falls back to the name rules rather than guessing at a shape.
 */
function typeRefOf(ann: unknown): TypeRef | undefined {
  if (!isNode(ann)) return undefined;
  const t = ann.type === 'TSTypeAnnotation' && isNode(ann.typeAnnotation) ? (ann.typeAnnotation as AstNode) : ann;
  if (t.type === 'TSTypeReference') {
    const tn = t.typeName as AstNode | undefined;
    // a qualified name (`ns.Type`) is not followed: the parser has no namespaces
    return tn && tn.type === 'Identifier' && typeof tn.name === 'string' ? { name: String(tn.name) } : undefined;
  }
  if (t.type === 'TSTypeLiteral') return { literal: typeMembers((t.members as AstNode[]) ?? []) };
  return undefined;
}

/**
 * The typed properties of an interface body (`TSInterfaceBody.body`) or an object-literal
 * type (`TSTypeLiteral.members`) — the hops a member-call path can be walked through.
 * Method signatures are not collected: what a type *promises* decides nothing; what a
 * class *declares* does, and that is the method index.
 */
function typeMembers(members: AstNode[]): Map<string, TypeRef> {
  const props = new Map<string, TypeRef>();
  for (const m of members) {
    if (!isNode(m) || m.computed || m.type !== 'TSPropertySignature') continue;
    const key = m.key as AstNode | undefined;
    const name = key && typeof key.name === 'string' ? String(key.name) : undefined;
    const ref = typeRefOf(m.typeAnnotation);
    if (name && ref) props.set(name, ref);
  }
  return props;
}

/** The parameter list of whatever kind of declaration a node is. */
function paramsOf(n: AstNode): AstNode[] {
  const fn = n.type === 'VariableDeclarator' ? (n.init as AstNode | undefined)
    : n.type === 'MethodDefinition' ? (n.value as AstNode | undefined)
    : n;
  return isNode(fn) && Array.isArray(fn.params) ? (fn.params as AstNode[]).filter(isNode) : [];
}

/**
 * The UPPER_SNAKE constant a base-URL expression starts with — `` `${BC_API_HOST}/v2.0` ``
 * or `BC_API_HOST + '/v2.0'`. The constant has to come *first*: a `${base}` after a
 * literal prefix is a path segment, not the host.
 */
function hostConstOf(v: unknown): string | null {
  if (!isNode(v)) return null;
  if (v.type === 'TemplateLiteral') {
    const head = (((v.quasis as AstNode[]) ?? [])[0]?.value as { cooked?: string } | undefined)?.cooked ?? '';
    if (head !== '') return null;
    return leftmostHostConst(((v.expressions as AstNode[]) ?? [])[0]);
  }
  if (v.type === 'BinaryExpression' && v.operator === '+') return leftmostHostConst(v.left);
  return null;
}

function leftmostHostConst(v: unknown): string | null {
  if (!isNode(v)) return null;
  if (v.type === 'BinaryExpression' && v.operator === '+') return leftmostHostConst(v.left);
  return v.type === 'Identifier' && HOST_CONST.test(String(v.name)) ? String(v.name) : null;
}

/** The host a constant's value names: `https://erp.example.com/v2` → `erp.example.com`. */
function hostOf(value: string): string | null {
  const url = value.match(/^https?:\/\/([^/]+)/);
  if (url) return url[1]!;
  return /^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(value) ? value : null;
}

function resolveImport(repoRoot: string, importerAbs: string, spec: string): string | null {
  const hit = resolveFileish(resolvePath(dirname(importerAbs), spec));
  return hit ? relative(repoRoot, hit) : null;
}

/** app/(marketing)/claims/[id] → /claims/:param — groups and @slots are invisible to the URL. */
function appRoutePath(dir: string): string {
  const segs = dir
    .split('/')
    .filter((s) => s && !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@'))
    .map((s) => (s.startsWith('[') ? ':param' : s));
  return '/' + segs.join('/');
}

/** Name of the default-exported function/identifier (App Router page/layout components). */
function defaultExportName(program: AstNode): string | null {
  let name: string | null = null;
  walk(program, (n) => {
    if (n.type !== 'ExportDefaultDeclaration') return;
    const d = n.declaration as AstNode | undefined;
    if (isNode(d)) {
      if (d.type === 'FunctionDeclaration' && isNode(d.id)) name = String((d.id as AstNode).name);
      else if (d.type === 'Identifier') name = String(d.name);
    }
    return false;
  });
  return name;
}

/** Does a Program or function body open with the given directive prologue ('use server' …)? */
function hasDirective(node: AstNode | null | undefined, directive: string): boolean {
  if (!isNode(node)) return false;
  if (Array.isArray(node.directives)) {
    for (const d of node.directives as AstNode[]) {
      const v = typeof d.directive === 'string' ? d.directive : stringValue(d.value);
      if (v === directive) return true;
    }
  }
  if (Array.isArray(node.body)) {
    for (const stmt of node.body as AstNode[]) {
      if (!isNode(stmt) || stmt.type !== 'ExpressionStatement') break;
      const v = typeof stmt.directive === 'string' ? stmt.directive : stringValue(stmt.expression);
      if (v === directive) return true;
      if (v === null) break; // directive prologue ends at the first non-string statement
    }
  }
  return false;
}

function fetchMethod(optionsArg: AstNode | undefined): string {
  let method = 'GET';
  walk(optionsArg, (n) => {
    if (n.type === 'Property' || n.type === 'ObjectProperty') {
      const key = n.key as AstNode | undefined;
      if (key && String(key.name ?? key.value) === 'method') {
        const v = stringValue(n.value);
        if (v) method = v.toUpperCase();
      }
    }
  });
  return method;
}

/** The text of a string or template literal (holes become `?`), else null — SQL detection reads this. */
function sqlLiteralText(n: AstNode): string | null {
  if ((n.type === 'Literal' || n.type === 'StringLiteral') && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') {
    const quasis = (n.quasis as AstNode[]) ?? [];
    return quasis.map((q) => ((q.value as { cooked?: string })?.cooked ?? '')).join(' ? ');
  }
  return null;
}

function langOf(file: string): string {
  return /\.tsx?$/.test(file) ? 'ts' : 'js';
}

/**
 * The call that actually makes the value in a chain: `build().catch(…).finally(…)`
 * → `build`. Promise tails and optional chaining are stripped; anything else (a
 * member call, a `new`, a literal, an identifier with no call) names nothing and
 * returns null — the heuristic stays silent rather than guessing (01 §2.3.3).
 */
function innermostCallee(n: unknown): string | null {
  let cur: AstNode | null = isNode(n) ? n : null;
  while (cur) {
    // oxc wraps `?.` in a ChainExpression around an ordinary CallExpression
    if (cur.type === 'ChainExpression' && isNode(cur.expression)) { cur = cur.expression as AstNode; continue; }
    if (cur.type !== 'CallExpression') return null;
    const callee = cur.callee as AstNode | undefined;
    if (!isNode(callee)) return null;
    if (callee.type === 'Identifier') return String(callee.name);
    if (callee.type === 'MemberExpression' || callee.type === 'StaticMemberExpression') {
      const prop = callee.property as AstNode | undefined;
      const tail = prop && typeof prop.name === 'string' ? prop.name : null;
      if (tail && PROMISE_TAILS.has(tail) && isNode(callee.object)) { cur = callee.object as AstNode; continue; }
    }
    return null;
  }
  return null;
}

/** Tag name of a JSX element, if it's a plain identifier (<Foo/> → "Foo"). */
function jsxName(n: unknown): string | null {
  if (!isNode(n) || n.type !== 'JSXElement') return null;
  const opening = n.openingElement as AstNode | undefined;
  const nm = opening?.name as AstNode | undefined;
  return nm && nm.type === 'JSXIdentifier' && typeof nm.name === 'string' ? nm.name : null;
}

/** JSDoc-ish comment immediately above a declaration (export/async/const may sit between). */
function leadingComment(source: string, start: number): string | null {
  return docCommentAbove(source, start, /^\s*(?:export\s+)?(?:async\s+)?(?:const\s+)?\s*$/);
}


// ── branch extraction (Journey forks) ────────────────────────────

/** Whitespace-collapsed source of an expression, capped for the condition/requires fields. */
function condText(source: string, n: AstNode): string {
  return sourceSlice(source, n).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** oxc may wrap tests in ParenthesizedExpression nodes — see through them. */
function unparen(n: AstNode): AstNode {
  let cur = n;
  while (cur.type === 'ParenthesizedExpression' && isNode(cur.expression)) cur = cur.expression as AstNode;
  return cur;
}

/** AST-aware negation: comparisons flip, `!x` unwraps, anything else wraps in `!(…)`. */
function negate(source: string, test: AstNode): string {
  const t = unparen(test);
  if (t.type === 'UnaryExpression' && t.operator === '!' && isNode(t.argument)) {
    return condText(source, t.argument as AstNode);
  }
  if (t.type === 'BinaryExpression' && typeof t.operator === 'string' && NEGATE_FLIP[t.operator] && isNode(t.left) && isNode(t.right)) {
    return `${condText(source, t.left as AstNode)} ${NEGATE_FLIP[t.operator]} ${condText(source, t.right as AstNode)}`.slice(0, 120);
  }
  return `!(${condText(source, t)})`.slice(0, 120);
}

/** Does the subtree gate flow — contain a call or JSX? Bare value ternaries/logicals are noise. */
function containsFlow(n: unknown): boolean {
  let found = false;
  walk(n, (b) => {
    if (found) return false;
    if (b.type === 'CallExpression' || b.type === 'JSXElement') { found = true; return false; }
  });
  return found;
}

/** Does an arm end in return/throw (its last top-level statement)? Guard-clause signal. */
function armExits(arm: AstNode): boolean {
  const last = arm.type === 'BlockStatement' && Array.isArray(arm.body)
    ? (arm.body as AstNode[]).filter(isNode).at(-1)
    : arm;
  return !!last && (last.type === 'ReturnStatement' || last.type === 'ThrowStatement');
}

/**
 * Decision points inside a body — the forks a Journey narrates. Nested
 * arrows/callbacks are walked too: line containment attributes their branches
 * to the right call sites downstream. Static conditions only.
 */
function extractBranches(body: AstNode | null, source: string, line: (offset: number) => number): BranchPoint[] {
  const out: BranchPoint[] = [];
  const span = (n: AstNode) => ({ line: line(n.start ?? 0), endLine: line(n.end ?? 0) });
  // fork/arm labels from `// @business …` directives — only present the key when found
  const bpBiz = (stmtOffset: number, testOffset?: number): { business?: string } => {
    const b = leadingBranchLabel(source, stmtOffset)
      ?? (testOffset != null ? trailingBranchLabel(source, testOffset) : undefined);
    return b ? { business: b } : {};
  };
  const armBiz = (offset: number, leadingToo = false): { business?: string } => {
    const b = trailingBranchLabel(source, offset)
      ?? (leadingToo ? leadingBranchLabel(source, offset) : undefined);
    return b ? { business: b } : {};
  };
  walk(body, (n) => {
    if (out.length >= MAX_BRANCH_POINTS) return false;

    if (n.type === 'IfStatement' && isNode(n.test) && isNode(n.consequent)) {
      const test = n.test as AstNode;
      const consequent = n.consequent as AstNode;
      const alternate = isNode(n.alternate) ? (n.alternate as AstNode) : null;
      const arms: BranchArm[] = [{ label: 'then', requires: condText(source, test), ...span(consequent), ...armBiz(consequent.start ?? 0) }];
      // else-if chains need no special case: this `else` arm spans the whole
      // alternate, so the nested if's own BranchPoint + containment give the conjunction
      if (alternate) arms.push({ label: 'else', requires: negate(source, test), ...span(alternate), ...armBiz(alternate.start ?? 0) });
      const exits = armExits(consequent) || (!!alternate && armExits(alternate));
      out.push({ kind: 'if', line: line(test.start ?? n.start ?? 0), condition: condText(source, test), ...(exits ? { exits: true as const } : {}), ...bpBiz(n.start ?? 0, test.start ?? 0), arms });
      return;
    }

    if (n.type === 'SwitchStatement' && isNode(n.discriminant)) {
      const disc = condText(source, n.discriminant as AstNode);
      const arms: BranchArm[] = [];
      let exits = false;
      for (const c of ((n.cases as AstNode[]) ?? []).filter(isNode)) {
        const t = isNode(c.test) ? (c.test as AstNode) : null;
        arms.push({
          label: t ? `case ${condText(source, t)}` : 'default',
          requires: t ? `${disc} === ${condText(source, t)}`.slice(0, 120) : 'no case matched',
          ...span(c),
          ...armBiz(c.start ?? 0, true), // trailing on `case X:` or a leading comment above it
        });
        const lastStmt = ((c.consequent as AstNode[]) ?? []).filter(isNode).at(-1);
        if (lastStmt && (lastStmt.type === 'ReturnStatement' || lastStmt.type === 'ThrowStatement')) exits = true;
      }
      if (arms.length) out.push({ kind: 'switch', line: line((n.discriminant as AstNode).start ?? n.start ?? 0), condition: disc, ...(exits ? { exits: true as const } : {}), ...bpBiz(n.start ?? 0, (n.discriminant as AstNode).start ?? 0), arms });
      return;
    }

    if (n.type === 'ConditionalExpression' && isNode(n.test) && isNode(n.consequent) && isNode(n.alternate)) {
      if (!containsFlow(n.consequent) && !containsFlow(n.alternate)) return;
      const test = n.test as AstNode;
      out.push({
        kind: 'ternary', line: line(test.start ?? n.start ?? 0), condition: condText(source, test),
        ...bpBiz(n.start ?? 0, test.start ?? 0),
        arms: [
          { label: 'then', requires: condText(source, test), ...span(n.consequent as AstNode), ...armBiz((n.consequent as AstNode).start ?? 0) },
          { label: 'else', requires: negate(source, test), ...span(n.alternate as AstNode), ...armBiz((n.alternate as AstNode).start ?? 0) },
        ],
      });
      return;
    }

    if (n.type === 'LogicalExpression' && isNode(n.left) && isNode(n.right)) {
      if (!containsFlow(n.right)) return;
      const op = String(n.operator);
      const lhs = n.left as AstNode;
      const requires =
        op === '&&' ? condText(source, lhs)
        : op === '||' ? negate(source, lhs)
        : `${condText(source, lhs)} == null`.slice(0, 120); // ??
      out.push({
        kind: 'logical', line: line(lhs.start ?? n.start ?? 0), condition: condText(source, n),
        ...bpBiz(n.start ?? 0, lhs.start ?? 0),
        arms: [{ label: 'taken', requires, ...span(n.right as AstNode), ...armBiz((n.right as AstNode).start ?? 0) }],
      });
      return;
    }

    if (n.type === 'TryStatement' && isNode(n.block) && isNode(n.handler)) {
      // try/finally without a catch clause is not a fork
      const handler = n.handler as AstNode;
      const catchBody = isNode(handler.body) ? (handler.body as AstNode) : handler;
      const exits = armExits(n.block as AstNode) || armExits(catchBody);
      out.push({
        kind: 'catch', line: line(n.start ?? 0), condition: 'exception in try',
        ...(exits ? { exits: true as const } : {}),
        ...bpBiz(n.start ?? 0), // try has no discriminant line — leading comment only
        arms: [
          { label: 'try', requires: 'no exception thrown', ...span(n.block as AstNode), ...armBiz((n.block as AstNode).start ?? 0) },
          { label: 'catch', requires: 'exception thrown', ...span(handler), ...armBiz(handler.start ?? 0) },
        ],
      });
      return;
    }
  });
  return out;
}

/** First lines of an implementation, capped for inspector preview. */
function snippetOf(source: string, n: AstNode): string {
  return snippetRange(source, n.start ?? 0, n.end ?? 0);
}

function sourceSlice(source: string, n: AstNode): string {
  return source.slice(n.start ?? 0, n.end ?? 0);
}

export const tsJsAdapter: LanguageAdapter = {
  id: 'ts-js',
  extensions: EXTS,
  async ingest(repoPath, options) {
    return ingestTsJs(repoPath, options);
  },
};
