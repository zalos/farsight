/**
 * NestJS controller semantics — what a `@Controller` class and its `@Get` / `@Post` … methods
 * declare, read off the decorator nodes oxc exposes (`ClassDeclaration.decorators`,
 * `MethodDefinition.decorators`). Framework knowledge lives here; `tsjs.ts` owns graph assembly,
 * the way `java/spring.ts` pairs with `java/index.ts`.
 *
 * Only what the code wrote as a literal is read. A path from an identifier or a template with
 * holes, `@All`, `@Version`, `setGlobalPrefix`, `enableVersioning` and `RouterModule` are each a
 * named gap (`RouteGap` on the fragment's `meta.routes`), never a guess at the URL.
 */
import type { RouteGap } from '@farsight/graph';
import { isNode, memberChain, walk, type AstNode } from './walk.js';
import { normalizePath } from './shared/tags.js';

/** The package whose `@Controller` makes a class a controller — same-named decorators from anywhere else are not read. */
export const NEST_COMMON = '@nestjs/common';

/** Method decorators → HTTP verb. `@All` is deliberately absent: it is a gap, not a verb. */
export const NEST_VERBS: Record<string, string> = {
  Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS',
};

/** What one file imports from Nest: its `@nestjs/common` bindings, and whether it imports any `@nestjs/*` package at all. */
export interface NestFile {
  /**
   * Local name → the member `@nestjs/common` exports it as. `import { Controller as Ctrl }` maps
   * Ctrl → Controller; `import * as common` maps common → `*` (so `@common.Get()` reads as Get).
   * Value imports only — a `type` import decorates nothing.
   */
  bindings: Map<string, string>;
  /** the file imports from some `@nestjs/*` package — the precondition for reading `app.setGlobalPrefix(…)` as Nest's */
  nest: boolean;
}

export function readNestFile(program: AstNode): NestFile {
  const bindings = new Map<string, string>();
  let nest = false;
  for (const stmt of ((program.body as AstNode[]) ?? [])) {
    if (!isNode(stmt) || stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type') continue;
    const src = (stmt.source as AstNode | undefined)?.value;
    if (typeof src !== 'string' || !src.startsWith('@nestjs/')) continue;
    nest = true;
    if (src !== NEST_COMMON) continue;
    for (const spec of ((stmt.specifiers as AstNode[]) ?? [])) {
      if (!isNode(spec) || spec.importKind === 'type') continue;
      const local = (spec.local as AstNode | undefined)?.name;
      if (typeof local !== 'string') continue;
      if (spec.type === 'ImportSpecifier') {
        const imp = spec.imported as AstNode | undefined;
        const imported = imp && (typeof imp.name === 'string' ? imp.name : typeof imp.value === 'string' ? imp.value : undefined);
        bindings.set(local, imported ?? local);
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        bindings.set(local, '*');
      }
    }
  }
  return { bindings, nest };
}

/** A decorator read as `@Name(args)` or `@ns.Name(args)`, where the name is a `@nestjs/common` binding of this file. */
export interface NestDecorator { name: string; args: AstNode[]; at: AstNode }

export function nestDecorator(dec: AstNode, file: NestFile): NestDecorator | undefined {
  const expr = dec.expression as AstNode | undefined;
  if (!isNode(expr)) return undefined;
  const call = expr.type === 'CallExpression';
  const chain = memberChain(call ? expr.callee : expr);
  let name: string | undefined;
  if (chain.length === 1) {
    const bound = file.bindings.get(chain[0]!);
    if (bound && bound !== '*') name = bound;
  } else if (chain.length === 2 && file.bindings.get(chain[0]!) === '*') {
    name = chain[1];
  }
  return name ? { name, args: call ? ((expr.arguments as AstNode[]) ?? []) : [], at: dec } : undefined;
}

/** A string the code wrote: a literal, or a template with no holes. Anything else names nothing here. */
export function literalString(n: unknown): string | undefined {
  if (!isNode(n)) return undefined;
  if ((n.type === 'Literal' || n.type === 'StringLiteral') && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && !((n.expressions as unknown[]) ?? []).length) {
    return ((n.quasis as AstNode[]) ?? []).map((q) => (q.value as { cooked?: string } | undefined)?.cooked ?? '').join('');
  }
  return undefined;
}

/** A string or an array of strings, all literal — undefined the moment one element is not. */
function pathList(n: AstNode): string[] | undefined {
  if (n.type === 'ArrayExpression') {
    const out: string[] = [];
    for (const el of ((n.elements as AstNode[]) ?? [])) {
      const s = literalString(el);
      if (s === undefined) return undefined;
      out.push(s);
    }
    return out;
  }
  const s = literalString(n);
  return s === undefined ? undefined : [s];
}

/**
 * The paths a `@Controller(…)` / `@Get(…)` argument names: no argument → `['']`, a string, an
 * array of strings (one route each), or `{ path }` (a `host`-only object is the empty prefix).
 * Undefined when any of them is not a literal — a constant, a template with a hole, a spread.
 */
export function pathsOf(args: AstNode[]): string[] | undefined {
  const arg = args[0];
  if (arg === undefined) return [''];
  if (!isNode(arg)) return undefined;
  if (arg.type === 'ObjectExpression') {
    const props = ((arg.properties as AstNode[]) ?? []).filter(isNode);
    if (props.some((p) => p.type === 'SpreadElement')) return undefined;
    const path = props.find((p) => (p.type === 'Property' || p.type === 'ObjectProperty') && !p.computed
      && String((p.key as AstNode | undefined)?.name ?? (p.key as AstNode | undefined)?.value) === 'path');
    return path && isNode(path.value) ? pathList(path.value as AstNode) : [''];
  }
  return pathList(arg);
}

/** `@Controller(…)` on a class: its prefixes (undefined = not literal, a gap) and the decorator node. */
export interface ControllerDecl { prefixes: string[] | undefined; at: AstNode }

export function controllerOf(cls: AstNode, file: NestFile): ControllerDecl | undefined {
  for (const dec of ((cls.decorators as AstNode[]) ?? [])) {
    if (!isNode(dec)) continue;
    const d = nestDecorator(dec, file);
    if (d?.name === 'Controller') return { prefixes: pathsOf(d.args), at: dec };
  }
  return undefined;
}

export interface MethodRoute { verb: string; path: string; decorator: string; at: AstNode }
export interface MethodGap { kind: RouteGap['kind']; decorator: string; at: AstNode }

/** The routes a method's verb decorators declare (one per path), and the decorators that could not become one. */
export function methodRoutes(m: AstNode, file: NestFile): { routes: MethodRoute[]; gaps: MethodGap[] } {
  const routes: MethodRoute[] = [];
  const gaps: MethodGap[] = [];
  for (const dec of ((m.decorators as AstNode[]) ?? [])) {
    if (!isNode(dec)) continue;
    const d = nestDecorator(dec, file);
    if (!d) continue;
    if (d.name === 'All') { gaps.push({ kind: 'all-verb', decorator: d.name, at: dec }); continue; }
    if (d.name === 'Version') { gaps.push({ kind: 'versioning', decorator: d.name, at: dec }); continue; }
    const verb = NEST_VERBS[d.name];
    if (!verb) continue;
    const paths = pathsOf(d.args);
    if (!paths) { gaps.push({ kind: 'non-literal-path', decorator: d.name, at: dec }); continue; }
    for (const path of paths) routes.push({ verb, path, decorator: d.name, at: dec });
  }
  return { routes, gaps };
}

/** One argument of `@UseGuards(…)`: the word for it, and the class it names when it is a plain class reference. */
export interface GuardRef { label: string; className?: string; at: AstNode }

export function useGuardsOf(decorators: unknown, file: NestFile): GuardRef[] {
  const out: GuardRef[] = [];
  for (const dec of ((decorators as AstNode[]) ?? [])) {
    if (!isNode(dec)) continue;
    const d = nestDecorator(dec, file);
    if (d?.name !== 'UseGuards') continue;
    for (const arg of d.args) {
      if (!isNode(arg)) continue;
      if (arg.type === 'Identifier' && typeof arg.name === 'string') { out.push({ label: arg.name, className: arg.name, at: dec }); continue; }
      // `new RolesGuard()` — the class, constructed here
      if (arg.type === 'NewExpression' && isNode(arg.callee) && (arg.callee as AstNode).type === 'Identifier') {
        const name = String((arg.callee as AstNode).name);
        out.push({ label: name, className: name, at: dec });
        continue;
      }
      // `AuthGuard('jwt')` — a factory: the class it returns is not in this file, so it names no method
      if (arg.type === 'CallExpression') {
        const chain = memberChain(arg.callee);
        if (!chain.length) continue;
        const lits = ((arg.arguments as AstNode[]) ?? []).map(literalString).filter((s): s is string => s !== undefined);
        out.push({ label: `${chain.join('.')}(${lits.join(', ')})`, at: dec });
        continue;
      }
      const chain = memberChain(arg);
      if (chain.length) out.push({ label: chain.join('.'), at: dec });
    }
  }
  return out;
}

/**
 * `return handler(req, ctx)` or `return await handler(…)` as the method's whole body → `handler`.
 * Any other shape — two statements, a member call, an inline function, a wrapper around the
 * handler — is undefined: the method's own calls are then walked as any function's are.
 */
export function delegateOf(m: AstNode): string | undefined {
  const fn = m.value as AstNode | undefined;
  const body = fn && isNode(fn) ? (fn.body as AstNode | undefined) : undefined;
  const stmts = body && isNode(body) ? ((body.body as AstNode[]) ?? []) : [];
  if (stmts.length !== 1) return undefined;
  const ret = stmts[0]!;
  if (!isNode(ret) || ret.type !== 'ReturnStatement' || !isNode(ret.argument)) return undefined;
  let call = ret.argument as AstNode;
  if (call.type === 'AwaitExpression' && isNode(call.argument)) call = call.argument as AstNode;
  if (call.type !== 'CallExpression' || !isNode(call.callee)) return undefined;
  const callee = call.callee as AstNode;
  return callee.type === 'Identifier' && typeof callee.name === 'string' ? callee.name : undefined;
}

/**
 * `@entrypoint http:VERB /path`, as `parseDoc` splits it (`['http', 'VERB', '/path']`) → the
 * route key it names, normalised the way route ids are. Undefined for any other entry point.
 */
export function entrypointRouteKey(parts: string[] | undefined): string | undefined {
  if (!parts || parts.length < 3 || parts[0]!.toLowerCase() !== 'http') return undefined;
  const verb = parts[1]!.toUpperCase();
  if (!Object.values(NEST_VERBS).includes(verb)) return undefined;
  const path = parts.slice(2).join(' ');
  return `${verb} ${normalizePath(path.startsWith('/') ? path : `/${path}`)}`;
}

/**
 * Prefixes and versions the app applies at boot that this reader does not fold into the routes:
 * `app.setGlobalPrefix(…)`, `app.enableVersioning(…)` and `RouterModule.register(…)` in a file
 * that imports from `@nestjs/*`. Each is a gap with a name — the routes read from the controllers
 * are recorded without it, and the gap says so.
 */
export function nestSetupGaps(program: AstNode, file: NestFile): { kind: RouteGap['kind']; name: string; text: string; at: AstNode }[] {
  if (!file.nest) return [];
  const out: { kind: RouteGap['kind']; name: string; text: string; at: AstNode }[] = [];
  walk(program, (n) => {
    if (n.type !== 'CallExpression') return;
    const chain = memberChain(n.callee);
    const tail = chain[chain.length - 1];
    const arg = literalString(((n.arguments as AstNode[]) ?? [])[0]);
    if (tail === 'setGlobalPrefix' && chain.length === 2) {
      out.push({ kind: 'global-prefix', name: chain.join('.'), at: n, text: `${chain.join('.')}(${arg !== undefined ? `'${arg}'` : '…'}) is not applied: the routes read from controllers are recorded without the global prefix` });
    } else if (tail === 'enableVersioning' && chain.length === 2) {
      out.push({ kind: 'versioning', name: chain.join('.'), at: n, text: `${chain.join('.')}(…) is not applied: the routes read from controllers are recorded without a version segment` });
    } else if (chain.length === 2 && chain[0] === 'RouterModule' && tail === 'register') {
      out.push({ kind: 'router-module', name: 'RouterModule.register', at: n, text: 'RouterModule.register(…) is not read: a module path it mounts controllers under is missing from their routes' });
    }
  });
  return out;
}
