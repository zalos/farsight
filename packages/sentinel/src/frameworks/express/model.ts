// The Express 4.21.2 registration model, read from captured source: the applications (`express()`) and routers
// (`express.Router()`) a source creates, the layers registered on each in static order, the mounts that join them,
// and what each middleware function certainly does. Only top-level registration statements are read as layers. Any
// other use of an application or router (a registration inside a function, branch or loop, the object passed to a
// function, assigned, or registered on from another module) makes that object open: its layers are not known, so
// every route it could reach stays unknown. Middleware never establishes a property here: a body read as a refusal
// is evidence of a conditional refusal only, and a name is evidence of nothing.
import { ModuleIndex, type Binding } from './modules.js';
import {
  identifierName, isFunction, memberPath, numberValue, stringValue, unwrap, walk, type JsFile, type JsNode,
} from './syntax.js';

export const EXPRESS_REASON_CODES = Object.freeze([
  'sentinel.express.versionUnresolved', 'sentinel.express.versionUnsupported', 'sentinel.express.sourceIncomplete',
  'sentinel.express.sourceNotUtf8', 'sentinel.express.scanLimit', 'sentinel.express.syntaxError',
  'sentinel.express.registrationDynamic', 'sentinel.express.registrationUnsupported', 'sentinel.express.pathUnsupported',
  'sentinel.express.layerMatchUnknown', 'sentinel.express.routingSettingUnsupported', 'sentinel.express.subAppUnsupported',
  'sentinel.express.paramCallback', 'sentinel.express.middlewareUnresolved', 'sentinel.express.middlewareThirdParty',
  'sentinel.express.middlewareEffectUnknown', 'sentinel.express.nextSkip', 'sentinel.express.routeNotMounted',
  'sentinel.express.routeObjectUnresolved', 'sentinel.express.surfaceAmbiguous', 'sentinel.express.mountsDisagree',
  'sentinel.express.routeNotIndexed', 'sentinel.express.mountCycle', 'sentinel.express.errorPathResumes',
  'sentinel.express.refusalUnproven',
] as const);
export type ExpressReason = typeof EXPRESS_REASON_CODES[number];

export interface At { readonly file: JsFile; readonly node: JsNode }

export interface ExpressObject {
  readonly id: string;
  readonly kind: 'app' | 'router';
  readonly at: At;
  readonly layers: Layer[];
  /** Why this object's layers are not known, with where it was used beyond the supported forms. */
  open?: At;
  /** A router option or application setting that changes path matching. */
  matching?: At;
  /** Where this object is mounted: the parent and the index of its mount layer there. */
  readonly mounts: { readonly parent: ExpressObject; readonly index: number }[];
  /** An application mounted inside another application. */
  subApp?: At;
}

export type Layer =
  | { readonly kind: 'middleware'; readonly path: string; readonly fn: JsNode; readonly file: JsFile; readonly at: At }
  | { readonly kind: 'mount'; readonly path: string; readonly target: ExpressObject; readonly at: At }
  | { readonly kind: 'route'; readonly path: string; readonly methods: readonly string[] | 'all'; readonly handlers: readonly JsNode[]; readonly file: JsFile; readonly at: At;
      /** Handlers registered through `route(path).<method>()` chains: one stack per method, not read. */ readonly chained?: boolean }
  | { readonly kind: 'param'; readonly at: At }
  | { readonly kind: 'unknown'; readonly reason: ExpressReason; readonly at: At };

export type Value =
  | { readonly kind: 'express' }
  | { readonly kind: 'router-factory' }
  | { readonly kind: 'express-member'; readonly name: string }
  | { readonly kind: 'object'; readonly obj: ExpressObject }
  | { readonly kind: 'namespace'; readonly file: JsFile }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'builtin'; readonly name: string; readonly at: At; readonly inert: boolean }
  | { readonly kind: 'function'; readonly file: JsFile; readonly node: JsNode; readonly bound: ReadonlyMap<string, BoundArg>; readonly via: At[] }
  | { readonly kind: 'foreign'; readonly from: string; readonly at: At }
  | { readonly kind: 'unknown'; readonly at: At };

/** A factory argument a returned middleware closes over: a literal value, or anything else (unknown). */
export type BoundArg = { readonly literal: string | number | boolean | null } | { readonly literal?: undefined };

const NODE_HTTP = new Set(['http', 'https', 'node:http', 'node:https']);
const VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);
const BUILTINS = new Set(['json', 'urlencoded', 'text', 'raw', 'static']);
const ROUTING_SETTINGS = new Set(['case sensitive routing', 'strict routing']);
const OPTION_INERT_KEYS = new Set(['limit', 'extended', 'type', 'strict', 'inflate', 'parameterLimit', 'defaultCharset',
  'index', 'dotfiles', 'etag', 'extensions', 'fallthrough', 'immutable', 'lastModified', 'maxAge', 'redirect']);

/** Test sources are not the application: an object created there does not mount or serve production routes. */
export const isTestPath = (p: string) => /(^|\/)(__tests__|tests?|e2e)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

export interface ExpressModel {
  readonly index: ModuleIndex;
  readonly objects: ExpressObject[];
  /** Registrations the pack met and could not follow, by file. */
  readonly frontiers: { readonly reason: ExpressReason; readonly at: At }[];
  resolveValue(file: JsFile, node: JsNode): Value;
  /** The route layers registered at a source line of a file. */
  routesAt(path: string, line: number): { obj: ExpressObject; index: number; layer: Extract<Layer, { kind: 'route' }> }[];
  /** Whether an expression's root binds to something that is certainly not Express (another package's object). */
  foreignObject(file: JsFile, node: JsNode): boolean;
}

export function buildModel(files: readonly JsFile[]): ExpressModel {
  const app = files.filter(f => !isTestPath(f.path));
  const index = new ModuleIndex(app);
  const objects: ExpressObject[] = [];
  const objectByDecl = new Map<JsNode, ExpressObject>();
  const frontiers: { reason: ExpressReason; at: At }[] = [];

  // ---- value resolution ----
  const resolving = new Set<JsNode>();
  const unknown = (file: JsFile, node: JsNode): Value => ({ kind: 'unknown', at: { file, node } });

  function resolveBinding(b: Binding, at: JsNode): Value {
    switch (b.kind) {
      case 'function': return { kind: 'function', file: b.file, node: b.node, bound: new Map(), via: [] };
      case 'declared': {
        const obj = objectByDecl.get(b.declarator);
        if (obj) return { kind: 'object', obj };
        return b.init ? resolveValue(b.file, b.init) : unknown(b.file, b.declarator);
      }
      case 'import': return resolveImport(b);
      default: return unknown(b.file, at);
    }
  }

  function resolveImport(b: Extract<Binding, { kind: 'import' }>): Value {
    const t = index.resolve(b.file, b.specifier);
    if (t.kind === 'package') {
      if (t.name !== 'express' || b.specifier !== 'express') return { kind: 'foreign', from: t.name, at: { file: b.file, node: b.at } };
      if (b.imported === 'default' || b.imported === 'require') return { kind: 'express' };
      if (b.imported === 'Router') return { kind: 'router-factory' };
      if (BUILTINS.has(b.imported)) return { kind: 'express-member', name: b.imported };
      return unknown(b.file, b.at);
    }
    if (t.kind === 'unresolved') return unknown(b.file, b.at);
    if (b.imported === '*') return { kind: 'namespace', file: t.file };
    if (b.imported === 'require' && !index.isCommonJs(t.file)) return unknown(b.file, b.at);
    const e = index.exportOf(t.file, b.imported === 'require' ? 'default' : b.imported);
    if (!e) return unknown(b.file, b.at);
    if (e.local) { const lb = index.binding(e.file, e.local); if (lb) return resolveBinding(lb, e.value); }
    return resolveValue(e.file, e.value);
  }

  function resolveValue(file: JsFile, raw: JsNode): Value {
    const node = unwrap(raw) ?? raw;
    if (resolving.has(node)) return unknown(file, node);
    resolving.add(node);
    try {
      return resolveInner(file, node);
    } finally { resolving.delete(node); }
  }

  function resolveInner(file: JsFile, node: JsNode): Value {
    const s = stringValue(node);
    if (s !== undefined) return { kind: 'string', value: s };
    if (isFunction(node)) return { kind: 'function', file, node, bound: new Map(), via: [] };
    if (node.type === 'Identifier') {
      const b = index.binding(file, node.name as string);
      return b ? resolveBinding(b, node) : unknown(file, node);
    }
    if (node.type === 'MemberExpression' && !node.computed) {
      const prop = identifierName(node.property as JsNode);
      const base = resolveValue(file, node.object as JsNode);
      if (!prop) return unknown(file, node);
      if (base.kind === 'express') {
        if (prop === 'Router') return { kind: 'router-factory' };
        if (BUILTINS.has(prop)) return { kind: 'express-member', name: prop };
        return unknown(file, node);
      }
      if (base.kind === 'namespace') {
        const e = index.exportOf(base.file, prop);
        if (!e) return unknown(file, node);
        if (e.local) { const lb = index.binding(e.file, e.local); if (lb) return resolveBinding(lb, e.value); }
        return resolveValue(e.file, e.value);
      }
      if (base.kind === 'foreign') return { kind: 'foreign', from: base.from, at: { file, node } };
      return unknown(file, node);
    }
    if (node.type === 'CallExpression') {
      const callee = unwrap(node.callee as JsNode)!;
      const args = node.arguments as JsNode[];
      if (callee.type === 'Identifier' && callee.name === 'require' && index.nodeRequire(file)) {
        const spec = args.length === 1 ? stringValue(args[0]) : undefined;
        if (spec === undefined) return unknown(file, node);
        return resolveImport({ kind: 'import', file, name: '', specifier: spec, imported: 'require', at: node });
      }
      const c = resolveValue(file, callee);
      if (c.kind === 'express-member') {
        return { kind: 'builtin', name: c.name, at: { file, node }, inert: args.length <= (c.name === 'static' ? 2 : 1) && inertOptions(c.name === 'static' ? args[1] : args[0]) && (c.name !== 'static' || stringValue(args[0]) !== undefined) };
      }
      if (c.kind === 'function') return factoryResult(c, file, node, args);
      if (c.kind === 'foreign') return { kind: 'foreign', from: c.from, at: { file, node } };
      return unknown(file, node);
    }
    return unknown(file, node);
  }

  /** A factory call `f(args)` whose body only returns a middleware function: that function, closing over the args. */
  function factoryResult(f: Extract<Value, { kind: 'function' }>, file: JsFile, call: JsNode, args: JsNode[]): Value {
    const fn = f.node;
    if (fn.async || fn.generator) return unknown(file, call);
    let returned: JsNode | undefined;
    const body = fn.body as JsNode;
    if (body.type === 'BlockStatement') {
      const stmts = body.body as JsNode[];
      if (stmts.length === 1 && stmts[0]!.type === 'ReturnStatement') returned = unwrap(stmts[0]!.argument as JsNode);
    } else returned = unwrap(body);
    if (!returned || !isFunction(returned)) return unknown(file, call);
    const params = fn.params as JsNode[];
    if (params.some(p => p.type !== 'Identifier') || args.some(a => a.type === 'SpreadElement')) return unknown(file, call);
    const bound = new Map<string, BoundArg>();
    params.forEach((p, i) => {
      const a = args[i];
      const lit = a ? literalOf(a) : { literal: undefined };
      bound.set(p.name as string, lit);
    });
    return { kind: 'function', file: f.file, node: returned, bound, via: [{ file, node: call }, { file: f.file, node: fn }] };
  }

  // ---- objects ----
  for (const file of app) {
    for (const s of file.program.body as JsNode[]) {
      const decl = s.type === 'VariableDeclaration' ? s : s.type === 'ExportNamedDeclaration' && (s.declaration as JsNode | undefined)?.type === 'VariableDeclaration' ? s.declaration as JsNode : undefined;
      if (!decl) continue;
      for (const d of decl.declarations as JsNode[]) {
        const init = unwrap(d.init as JsNode | undefined);
        const name = identifierName(d.id as JsNode);
        if (!name || init?.type !== 'CallExpression') continue;
        const c = resolveValue(file, init.callee as JsNode);
        if (c.kind !== 'express' && c.kind !== 'router-factory') continue;
        const obj: ExpressObject = { id: `${file.path}#${name}`, kind: c.kind === 'express' ? 'app' : 'router', at: { file, node: d }, layers: [], mounts: [] };
        if (decl.kind !== 'const') obj.open = { file, node: d };
        const args = init.arguments as JsNode[];
        if (obj.kind === 'app' && args.length) obj.open = { file, node: init };
        if (obj.kind === 'router' && args.length) {
          const opts = unwrap(args[0]);
          const readable = args.length === 1 && opts?.type === 'ObjectExpression' && (opts.properties as JsNode[]).every(p => p.type === 'Property' && !p.computed && literalOf(p.value as JsNode).literal !== undefined);
          const keys = readable ? (opts!.properties as JsNode[]).map(p => identifierName(p.key as JsNode) ?? stringValue(p.key as JsNode)) : [];
          if (!readable || keys.some(k => k !== 'mergeParams')) obj.matching = { file, node: init };
        }
        objects.push(obj);
        objectByDecl.set(d, obj);
      }
    }
  }

  // ---- registrations: top-level statements, in order ----
  const consumed = new Set<JsNode>();
  const routeLines = new Map<string, { obj: ExpressObject; index: number; layer: Extract<Layer, { kind: 'route' }> }[]>();
  const lineOf = (file: JsFile, node: JsNode) => { let l = 1; for (let i = 0; i < node.start; i++) if (file.text.charCodeAt(i) === 10) l++; return l; };

  const flatten = (args: JsNode[]): JsNode[] | undefined => {
    const out: JsNode[] = [];
    for (const a of args) {
      const u = unwrap(a)!;
      if (u.type === 'SpreadElement') return undefined;
      if (u.type === 'ArrayExpression') { const inner = flatten((u.elements as (JsNode | null)[]).filter((e): e is JsNode => !!e)); if (!inner) return undefined; out.push(...inner); }
      else out.push(a);
    }
    return out;
  };
  const pathArg = (file: JsFile, a: JsNode | undefined): string | 'unreadable' | undefined => {
    if (!a) return undefined;
    const v = resolveValue(file, a);
    if (v.kind === 'string') return v.value;
    const u = unwrap(a)!;
    if (u.type === 'ArrayExpression' || u.type === 'TemplateLiteral' || u.type === 'Literal' || u.type === 'BinaryExpression' || u.type === 'NewExpression') return 'unreadable';
    return v.kind === 'unknown' && u.type === 'Identifier' && !index.binding(file, u.name as string) ? 'unreadable' : undefined;
  };

  function addUse(obj: ExpressObject, file: JsFile, call: JsNode, args: JsNode[]) {
    const at = { file, node: call };
    let rest = args;
    let path = '/';
    const p = pathArg(file, args[0]);
    if (p === 'unreadable') { obj.layers.push({ kind: 'unknown', reason: 'sentinel.express.pathUnsupported', at }); return; }
    if (p !== undefined) { path = p; rest = args.slice(1); }
    const fns = flatten(rest);
    if (!fns || !fns.length) { obj.layers.push({ kind: 'unknown', reason: 'sentinel.express.registrationUnsupported', at }); return; }
    for (const fn of fns) {
      const v = resolveValue(file, fn);
      if (v.kind === 'object') {
        markConsumed(fn);
        if (v.obj.kind === 'app') {
          v.obj.subApp ??= { file, node: fn };
          obj.layers.push({ kind: 'unknown', reason: 'sentinel.express.subAppUnsupported', at: { file, node: fn } });
        } else {
          v.obj.mounts.push({ parent: obj, index: obj.layers.length });
          obj.layers.push({ kind: 'mount', path, target: v.obj, at: { file, node: fn } });
        }
      } else obj.layers.push({ kind: 'middleware', path, fn, file, at: { file, node: fn } });
    }
  }

  function addRoute(obj: ExpressObject, file: JsFile, call: JsNode, method: string, args: JsNode[]) {
    const at = { file, node: call };
    const p = pathArg(file, args[0]);
    const handlers = flatten(args.slice(1));
    if (p === undefined || p === 'unreadable') { obj.layers.push({ kind: 'unknown', reason: 'sentinel.express.pathUnsupported', at }); return; }
    if (!handlers || !handlers.length) { obj.layers.push({ kind: 'unknown', reason: 'sentinel.express.registrationUnsupported', at }); return; }
    const layer = { kind: 'route' as const, path: p, methods: method === 'all' ? 'all' as const : [method], handlers, file, at };
    const key = `${file.path}:${lineOf(file, call)}`;
    routeLines.set(key, [...routeLines.get(key) ?? [], { obj, index: obj.layers.length, layer }]);
    obj.layers.push(layer);
  }

  const markConsumed = (n: JsNode) => { const u = unwrap(n); if (u?.type === 'Identifier') consumed.add(u); };

  for (const file of app) {
    for (const s of file.program.body as JsNode[]) {
      if (s.type !== 'ExpressionStatement') continue;
      // Decompose a call chain `X.a(...).b(...)` into its root and calls.
      const calls: { name: string; args: JsNode[]; node: JsNode }[] = [];
      let cur = unwrap(s.expression as JsNode);
      while (cur?.type === 'CallExpression') {
        const callee = unwrap(cur.callee as JsNode);
        if (callee?.type !== 'MemberExpression' || callee.computed) break;
        const name = identifierName(callee.property as JsNode);
        if (!name) break;
        calls.unshift({ name, args: cur.arguments as JsNode[], node: cur });
        cur = unwrap(callee.object as JsNode);
      }
      if (!calls.length || cur?.type !== 'Identifier') continue;
      const root = resolveValue(file, cur);
      if (root.kind !== 'object') continue;
      const obj = root.obj;
      // A registration from another module runs in module-evaluation order, which this pack does not model.
      if (obj.at.file !== file) continue;
      consumed.add(cur);
      let route: { path: string | undefined; at: At; methods: string[] } | undefined;
      for (const c of calls) {
        if (route) {
          if (VERBS.has(c.name)) { route.methods.push(c.name); continue; }
          obj.open ??= { file, node: c.node };
          break;
        }
        if (c.name === 'use') addUse(obj, file, c.node, c.args);
        else if (VERBS.has(c.name)) {
          // `app.get('setting')` reads a setting; it registers nothing and ends the chain.
          if (obj.kind === 'app' && c.name === 'get' && c.args.length === 1) break;
          addRoute(obj, file, c.node, c.name, c.args);
        } else if (c.name === 'route') {
          const p = pathArg(file, c.args[0]);
          route = { path: typeof p === 'string' && p !== 'unreadable' ? p : undefined, at: { file, node: c.node }, methods: [] };
        } else if (c.name === 'param') obj.layers.push({ kind: 'param', at: { file, node: c.node } });
        else if (c.name === 'set' || c.name === 'enable' || c.name === 'disable') {
          const key = stringValue(c.args[0]);
          if (key === undefined || ROUTING_SETTINGS.has(key)) obj.matching ??= { file, node: c.node };
        } else if (c.name === 'engine') continue;
        else if (c.name === 'listen') break;
        else { obj.open ??= { file, node: c.node }; break; }
      }
      if (route) {
        // `route(path).<method>(…)`: one route layer whose stacks are not read here.
        if (route.path === undefined) obj.layers.push({ kind: 'unknown', reason: 'sentinel.express.pathUnsupported', at: route.at });
        else obj.layers.push({ kind: 'route', path: route.path, methods: route.methods.includes('all') ? 'all' : route.methods, handlers: [], file, at: route.at, chained: true });
      }
    }
  }

  // ---- every other use of an application or router opens it ----
  for (const file of app) {
    const names = new Map<string, ExpressObject>();
    for (const s of file.program.body as JsNode[]) void s;
    const candidates = new Set<string>();
    walk(file.program, n => { if (n.type === 'Identifier') candidates.add(n.name as string); });
    for (const name of candidates) {
      const b = index.binding(file, name);
      if (!b) continue;
      const v = resolveBinding(b, file.program);
      if (v.kind === 'object') names.set(name, v.obj);
    }
    if (!names.size) continue;
    walk(file.program, (n, parents) => {
      if (n.type !== 'Identifier') return;
      const obj = names.get(n.name as string);
      if (!obj || consumed.has(n)) return;
      const p = parents[parents.length - 1];
      const gp = parents[parents.length - 2];
      if (!p || !isReference(n, p)) return;
      if (p.type === 'MemberExpression' && p.object === n && identifierName(p.property as JsNode) === 'listen' && gp?.type === 'CallExpression' && gp.callee === p) return;
      if (p.type === 'CallExpression' && (p.arguments as JsNode[]).includes(n) && nodeCreateServer(file, p.callee as JsNode)) return;
      if (isExportPosition(n, parents)) return;
      obj.open ??= { file, node: n };
    });
  }

  /** `createServer` from Node's own http or https module (a named import, or a member of the module), nothing else. */
  function nodeCreateServer(file: JsFile, callee: JsNode): boolean {
    const path = memberPath(callee);
    if (!path || path[path.length - 1] !== 'createServer' || path.length > 2) return false;
    const b = index.binding(file, path[0]!);
    if (b?.kind !== 'import' || !NODE_HTTP.has(b.specifier)) return false;
    return path.length === 1 ? b.imported === 'createServer' : b.imported === 'default' || b.imported === '*' || b.imported === 'require';
  }

  for (const o of objects) {
    if (o.open) frontiers.push({ reason: 'sentinel.express.registrationDynamic', at: o.open });
    if (o.matching) frontiers.push({ reason: 'sentinel.express.routingSettingUnsupported', at: o.matching });
    if (o.subApp) frontiers.push({ reason: 'sentinel.express.subAppUnsupported', at: o.subApp });
    for (const l of o.layers) if (l.kind === 'unknown') frontiers.push({ reason: l.reason, at: l.at });
  }

  return {
    index, objects, frontiers, resolveValue,
    routesAt: (path, line) => routeLines.get(`${path}:${line}`) ?? [],
    foreignObject(file, node) {
      const root = unwrap(node);
      if (root?.type !== 'Identifier') return false;
      const b = index.binding(file, root.name as string);
      if (!b) return false;
      if (b.kind === 'import') { const t = index.resolve(b.file, b.specifier); return t.kind === 'package' && t.name !== 'express'; }
      if (b.kind === 'declared') {
        const init = unwrap(b.init);
        if (init?.type !== 'CallExpression') return false;
        const c = resolveValue(b.file, init.callee as JsNode);
        return c.kind === 'foreign';
      }
      return false;
    },
  };
}

/** Whether an identifier is a reference to a binding (not a declaration, property name, label or type). */
function isReference(n: JsNode, p: JsNode): boolean {
  switch (p.type) {
    case 'VariableDeclarator': return p.init === n;
    case 'MemberExpression': return p.object === n || !!p.computed;
    case 'Property': return p.value === n || (!!p.computed && p.key === n);
    case 'MethodDefinition': case 'PropertyDefinition': return !!p.computed && p.key === n;
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier': case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement':
      return false;
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
      return p.body === n;
    case 'ClassDeclaration': case 'ClassExpression': return p.superClass === n;
    case 'CatchClause': return false;
    default: return !p.type.startsWith('TS') || p.type === 'TSAsExpression' || p.type === 'TSSatisfiesExpression' || p.type === 'TSNonNullExpression';
  }
}

/** `export default X`, `module.exports = X`, `exports.x = X`, `module.exports = { X }`, `export { X }`. */
function isExportPosition(n: JsNode, parents: readonly JsNode[]): boolean {
  const p = parents[parents.length - 1]!;
  if (p.type === 'ExportDefaultDeclaration' || p.type === 'TSExportAssignment') return true;
  const assigned = (a: JsNode | undefined) => {
    if (a?.type !== 'AssignmentExpression') return false;
    const left = memberPath(a.left as JsNode);
    return !!left && ((left[0] === 'module' && left[1] === 'exports') || left[0] === 'exports');
  };
  if (assigned(p) && p.right === n) return true;
  if (p.type === 'Property' && p.value === n) {
    const obj = parents[parents.length - 2];
    const a = parents[parents.length - 3];
    return obj?.type === 'ObjectExpression' && assigned(a) && a!.right === obj;
  }
  return false;
}

/** A literal argument value, or `{}` when the expression is anything else. */
export function literalOf(node: JsNode): BoundArg {
  const n = unwrap(node);
  if (!n) return {};
  const s = stringValue(n);
  if (s !== undefined) return { literal: s };
  const num = numberValue(n);
  if (num !== undefined) return { literal: num };
  if (n.type === 'Literal' && (typeof n.value === 'boolean' || n.value === null)) return { literal: n.value as boolean | null };
  return {};
}

/** Options of a body parser or static server: absent, or an object of literal values under keys that run no code. */
function inertOptions(node: JsNode | undefined): boolean {
  const n = unwrap(node);
  if (!n) return true;
  if (n.type !== 'ObjectExpression') return false;
  return (n.properties as JsNode[]).every(p => {
    if (p.type !== 'Property' || p.computed) return false;
    const key = identifierName(p.key as JsNode) ?? stringValue(p.key as JsNode);
    if (!key || !OPTION_INERT_KEYS.has(key)) return false;
    const v = unwrap(p.value as JsNode)!;
    if (literalOf(v).literal !== undefined) return true;
    return v.type === 'ArrayExpression' && (v.elements as (JsNode | null)[]).every(e => !!e && literalOf(e).literal !== undefined);
  });
}
