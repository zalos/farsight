// Nest request controls for one captured source (PR 16, ADR 32). Inputs are the snapshot, the bytes it captured and
// the public parser's artifact for the same source; nothing is read from a live checkout, nothing is executed.
//
// The parser graph names the surfaces (route nodes and the handler each calls) and nothing more: an annotation match,
// a guard node or a reachable reader is never protection evidence. What applies to a surface is resolved here from
// the registrations the source writes, in Nest's order (guards, interceptors, pipes; global, controller, method,
// parameter). Validation, parsing, transformation and access control are distinct effects; only a ValidationPipe
// from @nestjs/common over a DTO whose class-validator rules are visible is validation, a multipart interceptor only
// parses, and a guard's effect is never inferred. Anything the pack cannot follow is a frontier with its reason, and
// a frontier that could change a verdict leaves it unknown.
import { sha256Hex, sha256Id as sha256 } from '../../kernel/digest.js';
import type { ArtifactId, ScopedReason, SourceEvidence } from '../../contracts/common.js';
import type { ControlFact, ControlFactsEnvelope } from '../../contracts/controls.js';
import type { SnapshotEnvelope } from '../../contracts/snapshot.js';
import { canonicalDigest } from '../../policy/digest.js';
import { deepFreeze } from '../../kernel/freeze.js';
import { validateEnvelope } from '../../validate.js';
import { NEST_PACK } from './support.js';
import { NestPackError, type NestReason, type NestReasonCode } from './errors.js';
import {
  bindsName,
  classesOf,
  decoratorCall,
  isFunction,
  loadParser,
  parseFile,
  patternNames,
  refName,
  resolveAt,
  resolveRef,
  SyntaxFailure,
  walk,
  walkWithAncestors,
  type AstNode,
  type ParsedFile,
  type Span,
} from './syntax.js';

/** A stage of Nest's request pipeline a binding takes part in. */
export type NestStage = 'guard' | 'interceptor' | 'pipe';
/** Where a binding is registered: globally, on a controller, on a method or on one parameter. */
export type NestScope = 'global' | 'controller' | 'method' | 'parameter';
/** What a binding does. `access-control-unresolved`: a guard, whose effect is never inferred. */
export type NestEffect = 'validation' | 'parsing' | 'transformation' | 'access-control-unresolved' | 'unknown';

/** One guard, interceptor or pipe on a surface's chain: where it comes from, how it was registered and what it does. */
export interface NestBinding {
  readonly stage: NestStage;
  readonly scope: NestScope;
  readonly name: string;
  readonly origin: '@nestjs/common' | '@nestjs/platform-express' | 'local' | 'external' | 'unresolved';
  readonly effect: NestEffect;
  readonly registeredBy: 'use-global' | 'app-provider' | 'decorator' | 'parameter';
  /** For a parameter pipe, the parameter's index. */
  readonly parameter?: number;
  /** A ValidationPipe whose options are not all literal is not a known validator. */
  readonly optionsKnown: boolean;
  readonly evidence: SourceEvidence;
}

/** One handler parameter that carries request input, with the validation class the pack resolved for it, if any. */
export interface NestInput {
  readonly index: number;
  readonly decorator: string;
  /** The parameter's annotated class, when it is one this pack resolved. */
  readonly dto: {
    readonly name: string;
    readonly relativePath: string;
    readonly rules: number;
    readonly conditional: boolean;
    readonly inherited: boolean;
  } | null;
  readonly typeName: string | null;
  readonly evidence: SourceEvidence;
}

/** One route handler: its controller, its chain in Nest's evaluation order, its inputs and its own frontiers. */
export interface NestSurface {
  readonly surfaceId: string;
  readonly controller: string;
  readonly handler: string;
  readonly relativePath: string;
  /** In Nest's evaluation order. */
  readonly chain: readonly NestBinding[];
  readonly inputs: readonly NestInput[];
  /** Frontiers that touch this surface only (global ones are on the report). */
  readonly frontiers: readonly string[];
}

/** What the pack read for one source: the framework versions, the global chain, each surface and every frontier. */
export interface NestScopeReport {
  readonly schema: 'sentinel-nest-scope/draft-1';
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly framework: {
    readonly version: string | null;
    readonly provenance: string | null;
    readonly classValidator: string | null;
  };
  readonly globals: readonly NestBinding[];
  readonly surfaces: readonly NestSurface[];
  readonly frontiers: readonly ScopedReason[];
}

/** The pack's two outputs: the control facts envelope and the scope report behind it. */
export interface NestAnalysis {
  readonly controls: ControlFactsEnvelope;
  readonly scope: NestScopeReport;
}

/** The parser artifact's graph, as far as this pack reads it: surface identities only. */
export interface ParserGraph {
  /** The graph's repository name, the prefix of its node ids (the source id when absent). */
  readonly repo?: string;
  readonly nodes: readonly { readonly id: string; readonly kind: string }[];
  readonly edges: readonly { readonly kind: string; readonly from: string; readonly to: string }[];
}

/** What analyzeNest reads: the snapshot, the source id, the parser graph, a reader of captured bytes and bounds. */
export interface NestAnalysisInput {
  readonly snapshot: SnapshotEnvelope;
  readonly sourceId: string;
  readonly graph: ParserGraph;
  /** Captured bytes by artifact id (the store's verified read). */
  readArtifact(id: ArtifactId): Promise<Uint8Array>;
  readonly limits?: { readonly maxFiles?: number; readonly maxFileBytes?: number };
}

const R = (code: NestReason): NestReasonCode => `sentinel.nest.${code}` as NestReasonCode;
const VERBS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All']);
const KNOWN_DECORATORS = new Set([
  'Controller',
  'UseGuards',
  'UseInterceptors',
  'UsePipes',
  'HttpCode',
  'Header',
  'Redirect',
  'Render',
  ...VERBS,
]);
const PARAM_DECORATORS = new Set([
  'Body',
  'Query',
  'Param',
  'Headers',
  'Req',
  'Request',
  'Res',
  'Response',
  'Ip',
  'UploadedFile',
  'UploadedFiles',
  'Session',
  'HostParam',
  'Next',
]);
const INPUT_DECORATORS = new Set(['Body', 'Query', 'Param', 'UploadedFile', 'UploadedFiles']);
const PARSE_PIPES = new Set([
  'ParseIntPipe',
  'ParseFloatPipe',
  'ParseBoolPipe',
  'ParseArrayPipe',
  'ParseUUIDPipe',
  'ParseEnumPipe',
  'ParseFilePipe',
]);
const MULTIPART = new Set([
  'FileInterceptor',
  'FilesInterceptor',
  'FileFieldsInterceptor',
  'AnyFilesInterceptor',
  'NoFilesInterceptor',
]);
const STAGE_OF: Record<string, NestStage> = {
  UseGuards: 'guard',
  UseInterceptors: 'interceptor',
  UsePipes: 'pipe',
  useGlobalGuards: 'guard',
  useGlobalInterceptors: 'interceptor',
  useGlobalPipes: 'pipe',
};
const APP_TOKENS: Record<string, NestStage> = { APP_GUARD: 'guard', APP_INTERCEPTOR: 'interceptor', APP_PIPE: 'pipe' };
const SCOPE_RANK: Record<NestScope, number> = { global: 0, controller: 1, method: 2, parameter: 3 };
const STAGE_RANK: Record<NestStage, number> = { guard: 0, interceptor: 1, pipe: 2 };
const EXACT = /^\d+\.\d+\.\d+$/;

interface Ctx {
  readonly input: NestAnalysisInput;
  readonly files: Map<string, ParsedFile>;
  readonly content: Map<string, ArtifactId>;
  readonly frontiers: ScopedReason[];
}

function evidenceOf(ctx: Ctx, file: ParsedFile, node: AstNode): SourceEvidence | null {
  const span: Span | null = file.span(node);
  if (!span) return null;
  const bytes = Buffer.from(file.text, 'utf8').subarray(span.startByte, span.endByte);
  return {
    snapshotId: ctx.input.snapshot.id,
    sourceId: ctx.input.sourceId,
    relativePath: file.path,
    content: ctx.content.get(file.path)!,
    span,
    quoteDigest: sha256(bytes),
  };
}

const frontier = (ctx: Ctx, path: string, code: NestReason) => {
  const scopeId = `${ctx.input.sourceId}:${path}`;
  if (!ctx.frontiers.some((f) => f.scopeId === scopeId && f.reasonCode === R(code)))
    ctx.frontiers.push({ scopeId, reasonCode: R(code) });
};

/** Resolves a relative import to a captured file path. */
function resolveModule(from: string, spec: string, files: Map<string, ParsedFile>): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  const base = parts.join('/');
  for (const cand of [`${base}.ts`, `${base}/index.ts`, `${base}.tsx`]) if (files.has(cand)) return cand;
  return null;
}

/** The class a reference names, when it is declared in a captured file. */
function findClass(ctx: Ctx, file: ParsedFile, local: string): { file: ParsedFile; node: AstNode } | null {
  const imp = file.imports.get(local);
  if (imp) {
    const target = resolveModule(file.path, imp.module, ctx.files);
    if (!target || imp.imported === '*' || imp.imported === 'default') return null;
    const tf = ctx.files.get(target)!;
    const c = classesOf(tf).find((c) => c.id?.name === imp.imported);
    return c ? { file: tf, node: c } : null;
  }
  const c = classesOf(file).find((c) => c.id?.name === local);
  return c ? { file, node: c } : null;
}

/** One registration argument: what it is and where it comes from. */
function classify(
  ctx: Ctx,
  file: ParsedFile,
  arg: AstNode,
  stage: NestStage,
  scope: NestScope,
  registeredBy: NestBinding['registeredBy'],
  parameter?: number,
): NestBinding | null {
  const ev = evidenceOf(ctx, file, arg);
  if (!ev) return null;
  let target: AstNode | undefined = arg;
  let call = false;
  if (arg.type === 'NewExpression') target = arg.callee;
  else if (arg.type === 'CallExpression') {
    target = arg.callee;
    call = true;
  }
  const ref = refName(target);
  const base = { stage, scope, registeredBy, evidence: ev, ...(parameter !== undefined ? { parameter } : {}) };
  if (
    !ref ||
    (arg.type !== 'Identifier' &&
      arg.type !== 'NewExpression' &&
      arg.type !== 'CallExpression' &&
      arg.type !== 'MemberExpression' &&
      arg.type !== 'StaticMemberExpression')
  ) {
    return { ...base, name: '(expression)', origin: 'unresolved', effect: 'unknown', optionsKnown: false };
  }
  // The name as the scope at the argument sees it: a parameter or local declaration named like an import is not it.
  const r = resolveAt(file, ref, target!.start);
  const name = r.name;
  if (r.module === '@nestjs/common') {
    const literalOptions = (arg.arguments ?? []).every(
      (a: AstNode) =>
        a.type === 'ObjectExpression' &&
        (a.properties ?? []).every(
          (p: AstNode) =>
            p.type === 'Property' &&
            !p.computed &&
            !p.method &&
            ['Literal', 'BooleanLiteral', 'NumericLiteral', 'StringLiteral'].includes(p.value?.type),
        ),
    );
    if (name === 'ValidationPipe' && stage === 'pipe' && !call)
      return {
        ...base,
        name,
        origin: '@nestjs/common',
        effect: 'validation',
        optionsKnown: validationOptionsKnown(arg),
      };
    if (PARSE_PIPES.has(name) && stage === 'pipe' && !call)
      return { ...base, name, origin: '@nestjs/common', effect: 'parsing', optionsKnown: literalOptions };
    if (
      (name === 'DefaultValuePipe' && stage === 'pipe') ||
      (name === 'ClassSerializerInterceptor' && stage === 'interceptor')
    )
      return { ...base, name, origin: '@nestjs/common', effect: 'transformation', optionsKnown: literalOptions };
    return {
      ...base,
      name,
      origin: '@nestjs/common',
      effect: stage === 'guard' ? 'access-control-unresolved' : 'unknown',
      optionsKnown: false,
    };
  }
  if (r.module === '@nestjs/platform-express' && MULTIPART.has(name) && stage === 'interceptor' && call) {
    return { ...base, name, origin: '@nestjs/platform-express', effect: 'parsing', optionsKnown: true };
  }
  if (r.module === null || r.module.startsWith('.')) {
    const local = call || r.shadowed ? null : findClass(ctx, file, ref.local);
    if (local)
      return {
        ...base,
        name,
        origin: 'local',
        effect: stage === 'guard' ? 'access-control-unresolved' : 'unknown',
        optionsKnown: false,
      };
    return {
      ...base,
      name,
      origin: 'unresolved',
      effect: stage === 'guard' ? 'access-control-unresolved' : 'unknown',
      optionsKnown: false,
    };
  }
  return {
    ...base,
    name,
    origin: 'external',
    effect: stage === 'guard' ? 'access-control-unresolved' : 'unknown',
    optionsKnown: false,
  };
}

/**
 * ValidationPipe options known not to weaken validation. Any other option (skipping missing, undefined or null
 * properties, groups, always, custom-decorator validation, transform options, an exception factory, ...) or a value that
 * is not a literal leaves whether the schema is enforced unknown.
 */
const SAFE_VALIDATION_OPTIONS: Record<string, (v: unknown) => boolean> = {
  whitelist: (v) => typeof v === 'boolean',
  forbidNonWhitelisted: (v) => typeof v === 'boolean',
  transform: (v) => typeof v === 'boolean',
  disableErrorMessages: (v) => typeof v === 'boolean',
  enableDebugMessages: (v) => typeof v === 'boolean',
  stopAtFirstError: (v) => typeof v === 'boolean',
  errorHttpStatusCode: (v) => typeof v === 'number',
  forbidUnknownValues: (v) => v === true,
};
function validationOptionsKnown(arg: AstNode): boolean {
  if (arg.type === 'Identifier' || arg.type === 'MemberExpression' || arg.type === 'StaticMemberExpression')
    return true; // the class itself: default options
  const args = arg.arguments ?? [];
  if (args.length === 0) return true;
  if (args.length !== 1 || args[0].type !== 'ObjectExpression') return false;
  return (args[0].properties ?? []).every((p: AstNode) => {
    if (p.type !== 'Property' || p.computed || p.method || p.kind !== 'init') return false;
    const key = String(p.key?.name ?? p.key?.value);
    const ok = Object.hasOwn(SAFE_VALIDATION_OPTIONS, key) ? SAFE_VALIDATION_OPTIONS[key]! : null;
    return ok !== null && ['Literal', 'BooleanLiteral', 'NumericLiteral'].includes(p.value?.type) && ok(p.value.value);
  });
}

/** True when a top-level statement of the module calls this function unconditionally (`f()`, `await f()`, `void f()`, `f().catch(...)`). */
function invokedAtTopLevel(file: ParsedFile, fn: AstNode): boolean {
  let name: string | null = null;
  for (const st of file.program.body ?? []) {
    const d = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
    if (d === fn && fn.id) name = String(fn.id.name);
    if (d?.type === 'VariableDeclaration' && d.kind === 'const')
      for (const v of d.declarations ?? []) if (v.init === fn && v.id?.type === 'Identifier') name = String(v.id.name);
  }
  if (!name) return false;
  return (file.program.body ?? []).some((st: AstNode) => {
    if (st.type !== 'ExpressionStatement') return false;
    let e = st.expression;
    for (;;) {
      if (e?.type === 'AwaitExpression') e = e.argument;
      else if (e?.type === 'UnaryExpression' && e.operator === 'void') e = e.argument;
      else if (
        e?.type === 'CallExpression' &&
        (e.callee?.type === 'MemberExpression' || e.callee?.type === 'StaticMemberExpression') &&
        ['then', 'catch', 'finally'].includes(e.callee.property?.name)
      )
        e = e.callee.object;
      else break;
    }
    return e?.type === 'CallExpression' && e.callee?.type === 'Identifier' && e.callee.name === name;
  });
}

/** True when the member expression at `anc[i]` (or a member chain built on it) is assigned, updated or deleted. */
function isWriteTarget(anc: readonly AstNode[], i: number): boolean {
  let k = i;
  while (
    k > 0 &&
    (anc[k - 1]!.type === 'MemberExpression' ||
      anc[k - 1]!.type === 'StaticMemberExpression' ||
      anc[k - 1]!.type === 'ComputedMemberExpression') &&
    anc[k - 1]!.object === anc[k]
  )
    k--;
  const node = anc[k]!,
    up = anc[k - 1];
  if (!up) return false;
  if (up.type === 'AssignmentExpression' && up.left === node) return true;
  if (up.type === 'UpdateExpression' && up.argument === node) return true;
  if (up.type === 'UnaryExpression' && up.operator === 'delete' && up.argument === node) return true;
  return false;
}

/** The identifier a member chain starts from (`a` in `a.b.c`), if any. */
function chainRoot(n: AstNode): string | null {
  let e = n;
  while (e) {
    if (['MemberExpression', 'StaticMemberExpression', 'ComputedMemberExpression'].includes(e.type)) e = e.object;
    else if (
      [
        'TSAsExpression',
        'TSTypeAssertion',
        'TSNonNullExpression',
        'TSSatisfiesExpression',
        'TSInstantiationExpression',
        'ParenthesizedExpression',
      ].includes(e.type)
    )
      e = e.expression;
    else break;
  }
  return e?.type === 'Identifier' ? String(e.name) : null;
}

const FRAMEWORK = /^(@nestjs\/|class-validator$|class-transformer$|reflect-metadata$)/;

/** The enclosing binding of this name, retaining lexical shadowing when following local aliases. */
function bindingScopeAt(file: ParsedFile, name: string, at: number): AstNode {
  let scope = file.program;
  walk(file.program, (n) => {
    if (at < n.start || at >= n.end) return false;
    if (bindsName(n, name)) scope = n;
    return undefined;
  });
  return scope;
}

/**
 * A mutation target may reach an imported framework object through local aliases, including member aliases and
 * reassignment. Follow every value of the same lexical binding conservatively: a conditional assignment can still
 * change the framework. Cycles terminate, and exceeding the alias bound leaves the mutation uncertain, never safe.
 */
function mayReferenceFramework(file: ParsedFile, target: AstNode, seen = new Set<AstNode>()): boolean {
  if (seen.has(target)) return false;
  if (seen.size >= 64) return true;
  seen.add(target);
  if (
    [
      'TSAsExpression',
      'TSTypeAssertion',
      'TSNonNullExpression',
      'TSSatisfiesExpression',
      'TSInstantiationExpression',
      'ParenthesizedExpression',
    ].includes(target.type)
  )
    return mayReferenceFramework(file, target.expression, seen);
  if (target.type === 'ConditionalExpression')
    return mayReferenceFramework(file, target.consequent, seen) || mayReferenceFramework(file, target.alternate, seen);
  if (target.type === 'AssignmentExpression') return mayReferenceFramework(file, target.right, seen);
  if (target.type === 'LogicalExpression')
    return mayReferenceFramework(file, target.left, seen) || mayReferenceFramework(file, target.right, seen);
  if (['MemberExpression', 'StaticMemberExpression', 'ComputedMemberExpression'].includes(target.type))
    return mayReferenceFramework(file, target.object, seen);
  const name = chainRoot(target);
  if (!name) return false;
  const imported = resolveAt(file, { local: name }, target.start);
  if (imported.module && FRAMEWORK.test(imported.module)) return true;
  const scope = bindingScopeAt(file, name, target.start);
  // A parameter is another object; its caller's values are not inferred from its spelling.
  if (
    (isFunction(scope) && (scope.params ?? []).some((p: AstNode) => patternNames(p).includes(name))) ||
    (scope.type === 'CatchClause' && patternNames(scope.param).includes(name))
  )
    return false;
  const values: AstNode[] = [];
  walk(file.program, (n) => {
    if (
      n.type === 'VariableDeclarator' &&
      n.init &&
      patternNames(n.id).includes(name) &&
      bindingScopeAt(file, name, n.id.start) === scope
    )
      values.push(n.init);
    if (
      n.type === 'AssignmentExpression' &&
      n.left?.type === 'Identifier' &&
      n.left.name === name &&
      bindingScopeAt(file, name, n.left.start) === scope
    )
      values.push(n.right);
    return undefined;
  });
  return values.some((value) => mayReferenceFramework(file, value, seen));
}

const RUNTIME_TS = new Set([
  'TSAsExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSInstantiationExpression',
  'TSEnumDeclaration',
  'TSEnumMember',
  'TSModuleDeclaration',
  'TSModuleBlock',
  'TSParameterProperty',
  'TSExportAssignment',
  'TSImportEqualsDeclaration',
]);
const MEMBER = new Set(['MemberExpression', 'StaticMemberExpression', 'ComputedMemberExpression']);

/** A host loader name is unavailable when a lexical or module declaration owns that spelling. */
function unboundGlobal(file: ParsedFile, name: string, at: number): boolean {
  if (file.imports.has(name) || resolveAt(file, { local: name }, at).shadowed) return false;
  return !(file.program.body ?? []).some((st: AstNode) => {
    const d = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
    return (
      d &&
      (d.id?.name === name ||
        (d.type === 'VariableDeclaration' &&
          (d.declarations ?? []).some((v: AstNode) => patternNames(v.id).includes(name))))
    );
  });
}

/** A static read of another property cannot carry this capability; aliases and unmodeled uses can. */
function mayExtractCapability(n: AstNode, anc: readonly AstNode[], path: readonly string[]): boolean {
  let child = n;
  for (let i = anc.length - 1; i >= 0; i--) {
    const p = anc[i]!;
    if (
      (RUNTIME_TS.has(p.type) || ['ParenthesizedExpression', 'ChainExpression'].includes(p.type)) &&
      p.expression === child
    ) {
      child = p;
      continue;
    }
    if (MEMBER.has(p.type) && p.object === child) {
      const key = !p.computed ? p.property?.name : p.property?.type === 'Literal' ? p.property.value : null;
      if (typeof key !== 'string') return true;
      if (key !== path[0]) return false;
      return path.length === 1 || mayExtractCapability(p, anc.slice(0, i), path.slice(1));
    }
    if (p.type === 'UnaryExpression' && ['typeof', 'void'].includes(p.operator)) return false;
    if (p.type === 'ExpressionStatement') return false;
    const pattern =
      p.type === 'VariableDeclarator' && p.init === child
        ? p.id
        : p.type === 'AssignmentExpression' && p.right === child
          ? p.left
          : null;
    if (pattern?.type === 'ObjectPattern')
      return (pattern.properties ?? []).some((q: AstNode) => {
        if (q.type !== 'Property') return true;
        const key = !q.computed ? (q.key?.name ?? q.key?.value) : q.key?.type === 'Literal' ? q.key.value : null;
        return typeof key !== 'string' || key === path[0];
      });
    return true;
  }
  return true;
}

/** Node's process object can create another module loader without importing node:module. */
function builtinLoaderEscapes(file: ParsedFile, n: AstNode, anc: readonly AstNode[]): boolean {
  const imported = resolveAt(file, { local: String(n.name) }, n.start);
  if (['node:process', 'process'].includes(imported.module ?? '')) {
    if (imported.name === 'getBuiltinModule') return true;
    if (['*', 'default'].includes(imported.name)) return mayExtractCapability(n, anc, ['getBuiltinModule']);
  }
  if (n.name === 'process' && unboundGlobal(file, 'process', n.start))
    return mayExtractCapability(n, anc, ['getBuiltinModule']);
  if (['globalThis', 'global'].includes(n.name) && unboundGlobal(file, n.name, n.start)) {
    return mayExtractCapability(n, anc, ['process', 'getBuiltinModule']);
  }
  return false;
}

/** A followed local alias must stay inside a declaration the binding pass understands, never an export/container. */
function bindingEscapes(file: ParsedFile, id: AstNode): boolean {
  const name = String(id.name);
  const scope = bindingScopeAt(file, name, id.start);
  let declared = isFunction(scope) && (scope.params ?? []).some((p: AstNode) => patternNames(p).includes(name));
  let escapes = false;
  walkWithAncestors(file.program, (n, anc) => {
    if (
      n.type !== 'VariableDeclarator' ||
      !patternNames(n.id).includes(name) ||
      bindingScopeAt(file, name, n.id.start) !== scope
    )
      return;
    declared = true;
    // A variable export is a live binding: an assignment made later escapes as well as its initializer.
    if (
      anc[anc.length - 2]?.type === 'ExportNamedDeclaration' ||
      anc.some((a) => a.type === 'TSModuleDeclaration' || a.type === 'TSModuleBlock')
    )
      escapes = true;
  });
  return !declared || escapes;
}

/** Declaration names, types and plain property names are not runtime values passed to another expression. */
function valueReference(n: AstNode, anc: readonly AstNode[]): boolean {
  // TSQualifiedName is normally a type. Under a value import-equals declaration its module reference is a
  // runtime value, so it must reach the default-unknown consumer rather than disappear with type annotations.
  const runtimeImport = anc.find(
    (a) =>
      a.type === 'TSImportEqualsDeclaration' &&
      a.importKind !== 'type' &&
      a.moduleReference?.start <= n.start &&
      a.moduleReference?.end >= n.end,
  );
  if (
    anc.some(
      (a) =>
        a.type === 'ImportDeclaration' ||
        (a.type === 'TSImportEqualsDeclaration' && a.importKind === 'type') ||
        (a.type.startsWith('TS') && !RUNTIME_TS.has(a.type) && !(a.type === 'TSQualifiedName' && runtimeImport)),
    )
  )
    return false;
  const parent = anc[anc.length - 1];
  if (!parent) return false;
  if (parent.type === 'AssignmentExpression' && parent.left === n) return false;
  if (
    (MEMBER.has(parent.type) && parent.property === n && !parent.computed) ||
    (['Property', 'MethodDefinition', 'PropertyDefinition', 'AccessorProperty'].includes(parent.type) &&
      parent.key === n &&
      !parent.computed) ||
    (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && parent.label === n) ||
    (parent.type === 'TSQualifiedName' && parent.right === n) ||
    (parent.type === 'TSEnumMember' && parent.id === n)
  )
    return false;
  let child = n;
  for (let i = anc.length - 1; i >= 0; i--) {
    const p = anc[i]!;
    if (
      (p.type === 'AssignmentPattern' && p.left === child) ||
      (p.type === 'RestElement' && p.argument === child) ||
      p.type === 'ArrayPattern' ||
      p.type === 'ObjectPattern' ||
      (p.type === 'Property' && anc[i - 1]?.type === 'ObjectPattern')
    ) {
      child = p;
      continue;
    }
    if (
      (p.type === 'VariableDeclarator' && p.id === child) ||
      (p.type === 'CatchClause' && p.param === child) ||
      (isFunction(p) && ((p.params ?? []).includes(child) || p.id === child)) ||
      (['ClassDeclaration', 'ClassExpression'].includes(p.type) && p.id === child)
    )
      return false;
    break;
  }
  return true;
}

/**
 * Follow a real framework reference only through proven bindings/receivers. Everything else is an escape by
 * default, including syntax not modeled here (tagged templates, parameter defaults, exports, field storage, ...).
 * Aggregate values may be consumed by a modeled framework decorator/registration, but never become a followed
 * local alias. This is a whitelist of supported uses, not an enumeration of ways JavaScript can hide a value.
 */
function frameworkReferenceEscapes(
  file: ParsedFile,
  n: AstNode,
  anc: readonly AstNode[],
  followed: ReadonlySet<AstNode>,
): boolean {
  let child = n;
  let opaque = false;
  for (let i = anc.length - 1; i >= 0; i--) {
    const p = anc[i]!;
    if (
      (MEMBER.has(p.type) && p.object === child) ||
      (RUNTIME_TS.has(p.type) && p.expression === child) ||
      (p.type === 'ParenthesizedExpression' && p.expression === child) ||
      (p.type === 'ConditionalExpression' && (p.consequent === child || p.alternate === child)) ||
      (p.type === 'LogicalExpression' && (p.left === child || p.right === child))
    ) {
      child = p;
      continue;
    }
    if (
      (p.type === 'Property' && p.value === child) ||
      ['ObjectExpression', 'ArrayExpression', 'SequenceExpression'].includes(p.type) ||
      (p.type === 'NewExpression' && p.callee === child)
    ) {
      opaque = true;
      child = p;
      continue;
    }
    if (p.type === 'VariableDeclarator' && p.init === child)
      return opaque || p.id.type !== 'Identifier' || bindingEscapes(file, p.id);
    if (p.type === 'AssignmentExpression' && p.right === child) {
      if (
        opaque ||
        p.left.type !== 'Identifier' ||
        !['=', '||=', '&&=', '??='].includes(p.operator) ||
        bindingEscapes(file, p.left)
      )
        return true;
      child = p;
      continue;
    }
    if (
      (p.type === 'AssignmentExpression' && p.left === child) ||
      (p.type === 'UpdateExpression' && p.argument === child) ||
      (p.type === 'UnaryExpression' && p.operator === 'delete' && p.argument === child)
    )
      return opaque || !MEMBER.has(child.type);
    if (p.type === 'CallExpression' || p.type === 'NewExpression') {
      const ref = refName(p.callee);
      const imported = ref ? resolveAt(file, ref, p.start) : null;
      const framework = !!imported?.module && FRAMEWORK.test(imported.module);
      const decorator = anc[i - 1]?.type === 'Decorator' && framework;
      // Every other global-registration call already has registrationNotFollowed below; preserve that more
      // precise frontier rather than treating its literal constructor argument as an ordinary helper escape.
      const registration = ref?.member && ref.member.startsWith('useGlobal') && STAGE_OF[ref.member];
      if ((p.arguments ?? []).includes(child)) return !followed.has(p) && !decorator && !registration;
      if (p.callee === child)
        return (
          opaque ||
          !(
            framework &&
            (!imported!.name.includes('.') ||
              (imported!.module === '@nestjs/core' && imported!.name === 'NestFactory.create'))
          )
        );
    }
    if (p.type === 'Decorator' && p.expression === child) {
      const ref = refName(child);
      const imported = ref ? resolveAt(file, ref, p.start) : null;
      return opaque || !imported?.module || !FRAMEWORK.test(imported.module);
    }
    // These discard or inspect a reference without storing it or handing it to another function.
    if (
      (p.type === 'ExpressionStatement' && p.expression === child) ||
      (p.type === 'UnaryExpression' && ['typeof', 'void', '!'].includes(p.operator) && p.argument === child)
    )
      return false;
    return true;
  }
  return true;
}

/** True when a statement can leave its function: a return or throw outside any nested function. */
function mayLeave(st: AstNode): boolean {
  let leaves = false;
  walk(st, (n) => {
    if (leaves || (n !== st && isFunction(n))) return false;
    if (n.type === 'ReturnStatement' || n.type === 'ThrowStatement') leaves = true;
    return undefined;
  });
  return leaves;
}

function decoratorsNamed(
  file: ParsedFile,
  node: AstNode,
): { name: string | null; module: string | null; d: AstNode; args: AstNode[] }[] {
  return (node.decorators ?? []).map((d: AstNode) => {
    const { callee, args } = decoratorCall(d);
    const ref = refName(callee);
    if (!ref) return { name: null, module: null, d, args };
    const r = resolveAt(file, ref, d.start);
    return { name: r.module === '@nestjs/common' ? r.name : null, module: r.module, d, args };
  });
}

/** class-validator decorators that make a property's other rules conditional. */
const CONDITIONAL_RULES = new Set(['ValidateIf', 'IsOptional']);
/** class-validator decorators that are not constraints: Allow only exempts a property from whitelisting. */
const NOT_RULES = new Set(['Allow']);
/** class-validator decorators whose effect lives in code the pack does not read: custom constraints and nested classes. */
const OPAQUE_RULES = new Set(['Validate', 'ValidateBy', 'ValidateNested', 'ValidatePromise']);

/**
 * The class-validator rules a DTO class declares on its properties, and whether any of them is conditional: a
 * ValidateIf or IsOptional, a rule restricted to groups or marked always, or options the pack cannot read. A class
 * that extends another inherits rules the pack does not follow.
 */
function dtoRules(file: ParsedFile, cls: AstNode): { rules: number; conditional: boolean; inherited: boolean } {
  let rules = 0;
  // A decorator the pack cannot prove harmless (a local wrapper, another library's, one on the class itself) may
  // register conditions or transformations of its own: whether the rules apply is then unknown.
  let conditional = (cls.decorators ?? []).length > 0;
  const literal = (a: AstNode): boolean =>
    ['Literal', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'RegExpLiteral'].includes(a.type) ||
    (a.type === 'TemplateLiteral' && (a.expressions ?? []).length === 0) ||
    (a.type === 'UnaryExpression' && a.operator === '-' && literal(a.argument)) ||
    (a.type === 'ArrayExpression' && (a.elements ?? []).every((e: AstNode | null) => e && literal(e)));
  for (const m of cls.body?.body ?? []) {
    for (const d of m.decorators ?? []) {
      const { callee, args } = decoratorCall(d);
      const ref = refName(callee);
      const r = ref ? resolveAt(file, ref, d.start) : null;
      if (!r || r.module !== 'class-validator') {
        conditional = true;
        continue;
      }
      if (NOT_RULES.has(r.name)) continue;
      if (CONDITIONAL_RULES.has(r.name) || OPAQUE_RULES.has(r.name)) {
        conditional = true;
        continue;
      }
      rules++;
      for (const a of args) {
        if (a.type === 'ObjectExpression') {
          for (const p of a.properties ?? []) {
            const key = p.type === 'Property' && !p.computed ? String(p.key?.name ?? p.key?.value) : null;
            if (key === null || key === 'groups' || key === 'always') conditional = true;
          }
        } else if (!literal(a)) conditional = true; // a value the pack cannot read could be options with groups or always
      }
    }
  }
  return { rules, conditional, inherited: !!cls.superClass };
}

function typeNameOf(param: AstNode): string | null {
  const id = param.type === 'TSParameterProperty' ? param.parameter : param;
  const ann = id?.typeAnnotation?.typeAnnotation;
  if (ann?.type === 'TSTypeReference' && ann.typeName?.type === 'Identifier') return String(ann.typeName.name);
  return null;
}

/** JSON with comments and trailing commas, with comment and comma bytes blanked so offsets still match the text. */
function blankJsonc(text: string): string {
  const out = text.split('');
  let i = 0;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? text.length : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? text.length : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(out[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') out[i] = ' ';
    }
    i++;
  }
  return out.join('');
}

type Metadata = { state: 'on' | 'off' | 'unknown'; evidence: SourceEvidence | null };

/**
 * Whether the compiler emits the parameter-type metadata ValidationPipe reads to find a DTO's class. Without it the
 * pipe sees no class and validates nothing. Read from the captured tsconfig.json nearest the controller: on only when
 * it sets both experimentalDecorators and emitDecoratorMetadata to true itself; off when it sets either to false, or
 * leaves metadata unset and extends nothing; unknown when it inherits them, cannot be read, or another compiler (SWC)
 * builds the project.
 */
async function decoratorMetadata(ctx: Ctx, controllerPath: string, cache: Map<string, Metadata>): Promise<Metadata> {
  const dirs = controllerPath.split('/').slice(0, -1);
  for (let n = dirs.length; n >= 0; n--) {
    const dir = dirs.slice(0, n).join('/');
    const path = dir ? `${dir}/tsconfig.json` : 'tsconfig.json';
    if (!ctx.content.has(path)) continue;
    if (cache.has(path)) return cache.get(path)!;
    const result = await (async (): Promise<Metadata> => {
      for (const other of ['.swcrc', dir ? `${dir}/.swcrc` : '.swcrc'])
        if (ctx.content.has(other)) return { state: 'unknown', evidence: null };
      for (const cli of ['nest-cli.json', dir ? `${dir}/nest-cli.json` : 'nest-cli.json']) {
        const id = ctx.content.get(cli);
        if (!id) continue;
        try {
          const conf = JSON.parse(
            blankJsonc(new TextDecoder('utf-8', { fatal: true }).decode(await ctx.input.readArtifact(id))),
          );
          const builder = conf?.compilerOptions?.builder;
          if (builder !== undefined && builder !== 'tsc' && builder?.type !== 'tsc')
            return { state: 'unknown', evidence: null };
        } catch {
          return { state: 'unknown', evidence: null };
        }
      }
      let text: string;
      let conf: any;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await ctx.input.readArtifact(ctx.content.get(path)!));
        conf = JSON.parse(blankJsonc(text));
      } catch {
        return { state: 'unknown', evidence: null };
      }
      const opts = conf?.compilerOptions ?? {};
      const at = (key: string) => {
        const matches = [...blankJsonc(text).matchAll(new RegExp(`"${key}"\\s*:\\s*(true|false)`, 'g'))];
        return matches.length === 1
          ? evidenceForText(ctx, path, text, matches[0]!.index!, matches[0]!.index! + matches[0]![0].length)
          : null;
      };
      if (opts.emitDecoratorMetadata === false || opts.experimentalDecorators === false)
        return {
          state: 'off',
          evidence: at(opts.emitDecoratorMetadata === false ? 'emitDecoratorMetadata' : 'experimentalDecorators'),
        };
      if (opts.emitDecoratorMetadata === true && opts.experimentalDecorators === true) {
        const ev = at('emitDecoratorMetadata');
        return ev ? { state: 'on', evidence: ev } : { state: 'unknown', evidence: null };
      }
      return conf?.extends !== undefined ? { state: 'unknown', evidence: null } : { state: 'off', evidence: null };
    })();
    cache.set(path, result);
    return result;
  }
  return { state: 'unknown', evidence: null };
}

function evidenceForText(ctx: Ctx, path: string, text: string, start: number, end: number): SourceEvidence {
  const startByte = Buffer.byteLength(text.slice(0, start), 'utf8');
  const endByte = startByte + Buffer.byteLength(text.slice(start, end), 'utf8');
  return {
    snapshotId: ctx.input.snapshot.id,
    sourceId: ctx.input.sourceId,
    relativePath: path,
    content: ctx.content.get(path)!,
    span: { startByte, endByte },
    quoteDigest: sha256(Buffer.from(text.slice(start, end), 'utf8')),
  };
}

/** Where a dependency resolves from a file: its version, the installed location, and the file that says so. */
type Resolved = { version: string; location: string; source: string; kind: 'lock' | 'pin' } | null;
type Versions = NestScopeReport['framework'] & {
  /** class-validator as the registered ValidationPipe and this DTO's decorators each load it; null unless the same supported copy. */
  classValidatorFor(registration: string, dto: string): string | null;
};

/**
 * Versions as Node would resolve each dependency from the file that imports it. Walking up from the file's folder,
 * the first folder whose install (the nearest captured package-lock.json's `<folder>/node_modules/<name>` entry) or
 * manifest (a package.json declaring the name) provides it decides: a lockfile entry gives its exact version; without
 * a lockfile, only an exact pin does. A range, or a lockfile that names no install, is unresolved; nothing is assumed
 * from a manifest that does not declare the dependency. The envelope's one Nest version is set only when the
 * bootstrap and every controller resolve @nestjs/common and @nestjs/core to the supported release. ValidationPipe
 * loads class-validator from where @nestjs/common is installed, while a DTO's decorators register with the copy the
 * DTO resolves: both must be the same installed copy of the supported release.
 */
async function versions(
  ctx: Ctx,
  nestFiles: readonly string[],
  dtoPairs: readonly (readonly [string, string])[],
): Promise<Versions> {
  const cache = new Map<string, any>();
  const read = async (path: string) => {
    if (cache.has(path)) return cache.get(path);
    const id = ctx.content.get(path);
    let v: any = null;
    if (id) {
      try {
        v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await ctx.input.readArtifact(id)));
      } catch {
        v = null;
      }
    }
    cache.set(path, v);
    return v;
  };
  const at = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  const parent = (dir: string) => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');
  const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const resolveFor = async (file: string, name: string): Promise<Resolved> => {
    let lockDir: string | null = null;
    for (let d = parent(file); ; d = parent(d)) {
      if (ctx.content.has(at(d, 'package-lock.json'))) {
        lockDir = d;
        break;
      }
      if (d === '') break;
    }
    const lockPath = lockDir === null ? null : at(lockDir, 'package-lock.json');
    const lock = lockPath ? await read(lockPath) : null;
    if (lockPath && !lock) return null;
    for (let dir = parent(file); ; dir = parent(dir)) {
      if (lock && lockDir !== null && (lockDir === '' || dir === lockDir || dir.startsWith(`${lockDir}/`))) {
        const rel = lockDir === '' ? dir : dir === lockDir ? '' : dir.slice(lockDir.length + 1);
        const entry = lock.packages?.[at(rel, `node_modules/${name}`)];
        if (entry !== undefined)
          return typeof entry?.version === 'string' && EXACT.test(entry.version)
            ? { version: entry.version, location: at(dir, `node_modules/${name}`), source: lockPath!, kind: 'lock' }
            : null;
      }
      const pkg = await read(at(dir, 'package.json'));
      const spec = DEP_FIELDS.map((f) => pkg?.[f]?.[name]).find((v) => v !== undefined);
      if (spec !== undefined) {
        // Declared here: without a lockfile the pin decides; with one, npm may have hoisted the install, so keep looking.
        if (!lock)
          return typeof spec === 'string' && EXACT.test(spec)
            ? { version: spec, location: at(dir, `node_modules/${name}`), source: at(dir, 'package.json'), kind: 'pin' }
            : null;
      }
      // Declared with a lockfile that names no install for it: npm would have recorded one, so this is unresolved.
      if (dir === '') return null;
    }
  };
  let ok = nestFiles.length > 0;
  const commons: NonNullable<Resolved>[] = [];
  if (!nestFiles.length) frontier(ctx, 'package.json', 'versionUnresolved');
  for (const f of new Set(nestFiles)) {
    const common = await resolveFor(f, '@nestjs/common'),
      core = await resolveFor(f, '@nestjs/core');
    if (!common || !core) {
      frontier(ctx, f, 'versionUnresolved');
      ok = false;
      continue;
    }
    if (
      common.version !== NEST_PACK.versions['@nestjs/common'] ||
      core.version !== NEST_PACK.versions['@nestjs/core']
    ) {
      frontier(
        ctx,
        common.version !== NEST_PACK.versions['@nestjs/common'] ? common.source : core.source,
        'versionUnsupported',
      );
      ok = false;
      continue;
    }
    commons.push(common);
  }
  const cvCache = new Map<string, string | null>();
  const classValidatorFor = async (registration: string, dto: string): Promise<string | null> => {
    const key = `${registration}\u0000${dto}`;
    if (cvCache.has(key)) return cvCache.get(key)!;
    const common = await resolveFor(registration, '@nestjs/common');
    const fromPipe =
      common?.kind === 'lock'
        ? await resolveFor(`${common.location}/index.js`, 'class-validator')
        : await resolveFor(registration, 'class-validator');
    const fromDto = await resolveFor(dto, 'class-validator');
    const v =
      fromPipe &&
      fromDto &&
      fromPipe.location === fromDto.location &&
      fromPipe.version === fromDto.version &&
      fromDto.version === NEST_PACK.versions['class-validator']
        ? fromDto.version
        : null;
    cvCache.set(key, v);
    return v;
  };
  const sources = [...new Set(commons.map((c) => c.source))].sort();
  const pairs = new Map<string, string | null>();
  for (const [c, d] of dtoPairs) pairs.set(`${c}\u0000${d}`, await classValidatorFor(c, d));
  const all = new Set(pairs.values());
  return {
    version: ok ? NEST_PACK.versions['@nestjs/common'] : null,
    provenance: ok ? sources.join(', ') : null,
    classValidator: all.size === 1 ? [...all][0]! : null,
    classValidatorFor: (registration: string, dto: string) => pairs.get(`${registration}\u0000${dto}`) ?? null,
  };
}

/**
 * Control facts for one source's Nest handlers, from captured bytes only: nothing is executed or imported. A guard's
 * effect is never inferred and anything outside the supported forms is a frontier, never a protection. Refuses, with a
 * NestPackError, only an envelope of its own that does not validate.
 */
export async function analyzeNest(input: NestAnalysisInput): Promise<NestAnalysis> {
  const maxFiles = input.limits?.maxFiles ?? 2000;
  const maxFileBytes = input.limits?.maxFileBytes ?? 1024 * 1024;
  const ctx: Ctx = { input, files: new Map(), content: new Map(), frontiers: [] };
  // 1. The captured TypeScript of this source, parsed from the store's bytes.
  await loadParser();
  const entries = input.snapshot.entries.filter(
    (e) => e.sourceId === input.sourceId && e.kind === 'file' && e.disposition === 'included',
  );
  for (const e of entries)
    if (e.kind === 'file' && e.disposition === 'included') ctx.content.set(e.relativePath, e.content);
  let read = 0;
  for (const e of entries) {
    if (
      e.kind !== 'file' ||
      e.disposition !== 'included' ||
      !/\.tsx?$/.test(e.relativePath) ||
      e.relativePath.endsWith('.d.ts')
    )
      continue;
    if (/(^|\/)node_modules\//.test(e.relativePath)) continue;
    if (++read > maxFiles || e.bytes > maxFileBytes) {
      frontier(ctx, e.relativePath, 'fileNotRead');
      continue;
    }
    try {
      ctx.files.set(e.relativePath, parseFile(e.relativePath, await input.readArtifact(e.content)));
    } catch (err) {
      frontier(
        ctx,
        e.relativePath,
        err instanceof SyntaxFailure && err.reason === 'invalidUtf8' ? 'invalidUtf8' : 'parseFailed',
      );
    }
  }
  // Files the capture recorded without bytes may hold registrations: each is a frontier.
  for (const e of input.snapshot.entries) {
    if (
      e.sourceId === input.sourceId &&
      e.kind === 'file' &&
      e.disposition !== 'included' &&
      /\.tsx?$/.test(e.relativePath)
    )
      frontier(ctx, e.relativePath, 'fileNotCaptured');
  }

  // 2. The bootstrap: exactly one NestFactory.create(Module) and the application's global registrations.
  const globals: NestBinding[] = [];
  let rootModule: { file: ParsedFile; node: AstNode } | null = null;
  let bootstrapEvidence: SourceEvidence | null = null;
  // The application object, as the bootstrap declares it: `const app = [await] NestFactory.create(Module)` as a
  // statement of the bootstrap's own body (or the module's). Any other shape is not followed.
  interface Create {
    file: ParsedFile;
    call: AstNode;
    app: string | null;
    body: AstNode[] | null;
    statement: AstNode | null;
    fn: AstNode | null;
  }
  const creates: Create[] = [];
  for (const file of ctx.files.values()) {
    walkWithAncestors(file.program, (n, anc) => {
      if (n.type !== 'CallExpression') return;
      const ref = refName(n.callee);
      if (!ref || ref.member !== 'create') return;
      const r = resolveAt(file, { local: ref.local }, n.start);
      if (r.module !== '@nestjs/core' || r.name !== 'NestFactory') return;
      const up = [...anc].reverse();
      let k = 0;
      if (up[k]?.type === 'AwaitExpression') k++;
      const decl = up[k],
        declaration = up[k + 1],
        container = up[k + 2],
        owner = up[k + 3];
      const shaped =
        decl?.type === 'VariableDeclarator' &&
        decl.id?.type === 'Identifier' &&
        declaration?.type === 'VariableDeclaration' &&
        declaration.kind === 'const' &&
        (container?.type === 'Program' || (container?.type === 'BlockStatement' && isFunction(owner)));
      creates.push({
        file,
        call: n,
        app: shaped ? String(decl.id.name) : null,
        body: shaped ? container.body : null,
        statement: shaped ? declaration : null,
        fn: shaped && container.type !== 'Program' ? (owner ?? null) : null,
      });
      return false;
    });
  }
  if (creates.length !== 1)
    frontier(ctx, creates[1]?.file.path ?? 'main.ts', creates.length ? 'bootstrapAmbiguous' : 'bootstrapNotFound');
  const boot = creates.length === 1 ? creates[0]! : null;
  const followed = new Set<AstNode>();
  if (boot) {
    bootstrapEvidence = evidenceOf(ctx, boot.file, boot.call);
    const arg = boot.call.arguments?.[0];
    const ref =
      arg?.type === 'Identifier' && !resolveAt(boot.file, { local: String(arg.name) }, arg.start).shadowed
        ? refName(arg)
        : null;
    rootModule = ref ? findClass(ctx, boot.file, ref.local) : null;
    if (!rootModule) frontier(ctx, boot.file.path, 'rootModuleUnresolved');
    if (!boot.app || !boot.body || !boot.statement) frontier(ctx, boot.file.path, 'applicationUnresolved');
    else {
      // The bootstrap must run: a function the module calls unconditionally at its top level (or the module itself).
      if (boot.fn && !invokedAtTopLevel(boot.file, boot.fn)) frontier(ctx, boot.file.path, 'bootstrapNotInvoked');
      const app = boot.app;
      const fnBody = boot.fn ?? boot.file.program;
      const bodyBlock = boot.fn ? boot.fn.body : boot.file.program;
      // Every use of the application other than a method call on it passes it where its registrations cannot be seen.
      walkWithAncestors(fnBody, (n, anc) => {
        if (n.type !== 'Identifier' || n.name !== app) return;
        const parent = anc[anc.length - 1];
        if (parent === undefined || (parent.type === 'VariableDeclarator' && parent.id === n)) return;
        if (
          (parent.type === 'MemberExpression' || parent.type === 'StaticMemberExpression') &&
          parent.object === n &&
          !parent.computed
        ) {
          // A method call on the application is read as itself only while nothing replaces its members.
          if (isWriteTarget(anc, anc.length - 1)) frontier(ctx, boot.file.path, 'applicationMutated');
          return;
        }
        // A nested scope that declares its own `app` is a different binding.
        if (anc.slice(anc.indexOf(fnBody) + 1).some((a) => a !== bodyBlock && bindsName(a, app))) return;
        frontier(ctx, boot.file.path, 'applicationEscapes');
      });
      walk(fnBody, (n) => {
        if (n.type !== 'CallExpression') return;
        const r = refName(n.callee);
        if (r?.member === 'getHttpAdapter') frontier(ctx, boot.file.path, 'adapterRouteNotModeled');
        if (r?.local === app && r.member === 'use') frontier(ctx, boot.file.path, 'middlewareNotModeled');
      });
      // Straight-line statements after the create, until the application initializes: only those certainly run, in
      // this order, before routes are built. A statement that can leave the function ends certainty for the rest.
      let definite = true;
      let initialized = false;
      for (const st of boot.body.slice(boot.body.indexOf(boot.statement) + 1)) {
        const expr =
          st.type === 'ExpressionStatement'
            ? st.expression?.type === 'AwaitExpression'
              ? st.expression.argument
              : st.expression
            : null;
        const r = expr?.type === 'CallExpression' ? refName(expr.callee) : null;
        if (r && r.local === app && r.member && definite && !initialized) {
          if (r.member === 'init' || r.member === 'listen') initialized = true;
          const stage = STAGE_OF[r.member];
          if (stage) {
            followed.add(expr);
            for (const a of expr.arguments ?? []) {
              if (a.type === 'SpreadElement') {
                frontier(ctx, boot.file.path, 'nonLiteralRegistration');
                continue;
              }
              const b = classify(ctx, boot.file, a, stage, 'global', 'use-global');
              if (b) globals.push(b);
              else frontier(ctx, boot.file.path, 'spanUnavailable');
            }
          }
        }
        if (mayLeave(st)) definite = false;
      }
    }
  }
  // Code that rewrites the framework, class-validator, class-transformer or reflected metadata can change what any
  // registration, pipe or rule does: nothing it could change is established.
  for (const file of ctx.files.values()) {
    walkWithAncestors(file.program, (n, anc) => {
      if (
        ['MemberExpression', 'StaticMemberExpression', 'ComputedMemberExpression'].includes(n.type) &&
        isWriteTarget([...anc, n], anc.length) &&
        mayReferenceFramework(file, n)
      )
        frontier(ctx, file.path, 'frameworkMutated');
      // Framework values obtained through unmodeled module loaders are not proven local ESM bindings. A
      // captured literal load is explicit; a loader handed on as a value may load the framework later as well.
      if (n.type === 'ImportExpression' && (n.source?.type !== 'Literal' || FRAMEWORK.test(String(n.source.value))))
        frontier(ctx, file.path, 'frameworkEscapes');
      if (n.type === 'Identifier' && valueReference(n, anc)) {
        const imported = resolveAt(file, { local: String(n.name) }, n.start);
        const loaderFactory =
          ['node:module', 'module'].includes(imported.module ?? '') &&
          ['createRequire', '*', 'default'].includes(imported.name);
        const require = n.name === 'require' && unboundGlobal(file, 'require', n.start);
        if (
          loaderFactory ||
          builtinLoaderEscapes(file, n, anc) ||
          (n.name === 'module' && unboundGlobal(file, 'module', n.start))
        )
          frontier(ctx, file.path, 'frameworkEscapes');
        if (require) {
          const p = anc[anc.length - 1];
          if (
            p?.type !== 'CallExpression' ||
            p.callee !== n ||
            p.arguments?.[0]?.type !== 'Literal' ||
            FRAMEWORK.test(String(p.arguments[0].value))
          )
            frontier(ctx, file.path, 'frameworkEscapes');
        }
      }
      if (
        n.type === 'TSImportEqualsDeclaration' &&
        n.importKind !== 'type' &&
        n.moduleReference?.type === 'TSExternalModuleReference' &&
        FRAMEWORK.test(String(n.moduleReference.expression?.value ?? ''))
      )
        frontier(ctx, file.path, 'frameworkEscapes');
      if (
        ['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(n.type) &&
        FRAMEWORK.test(String(n.source?.value ?? ''))
      )
        frontier(ctx, file.path, 'frameworkEscapes');
      if (
        n.type === 'Identifier' &&
        valueReference(n, anc) &&
        mayReferenceFramework(file, n) &&
        frameworkReferenceEscapes(file, n, anc, followed)
      )
        frontier(ctx, file.path, 'frameworkEscapes');
      if (n.type === 'CallExpression') {
        const r = refName(n.callee);
        const target = n.arguments?.[0];
        if (
          r &&
          ['Object', 'Reflect'].includes(r.local) &&
          !resolveAt(file, { local: r.local }, n.start).shadowed &&
          ['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf', 'set', 'deleteProperty'].includes(
            r.member ?? '',
          ) &&
          target &&
          mayReferenceFramework(file, target)
        ) {
          frontier(ctx, file.path, 'frameworkMutated');
        }
        if (r?.local === 'Reflect' && ['defineMetadata', 'deleteMetadata', 'metadata'].includes(r.member ?? ''))
          frontier(ctx, file.path, 'frameworkMutated');
      }
      return undefined;
    });
  }
  // A global registration anywhere else (conditional, after initialization, in another function, on another binding)
  // is not followed, and it could change any chain.
  for (const file of ctx.files.values()) {
    walk(file.program, (n) => {
      if (n.type !== 'CallExpression' || followed.has(n)) return;
      const r = refName(n.callee);
      if (r?.member && STAGE_OF[r.member] && r.member.startsWith('useGlobal'))
        frontier(ctx, file.path, 'registrationNotFollowed');
    });
  }

  // 3. The module graph from the root module: controllers, global providers, and what cannot be followed.
  const controllers = new Map<string, { file: ParsedFile; node: AstNode }>();
  const seen = new Set<string>();
  const visitModule = (m: { file: ParsedFile; node: AstNode }) => {
    const key = `${m.file.path}::${m.node.id?.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const dec = decoratorsNamed(m.file, m.node).find((d) => d.name === 'Module');
    const meta = dec?.args[0];
    if (!dec || meta?.type !== 'ObjectExpression') {
      frontier(ctx, m.file.path, 'moduleUnresolved');
      return;
    }
    for (const p of meta.properties ?? []) {
      const key = p.type === 'Property' && !p.computed ? String(p.key?.name ?? p.key?.value) : null;
      if (!key || p.value?.type !== 'ArrayExpression') {
        if (p.type === 'SpreadElement' || (key && ['imports', 'providers', 'controllers'].includes(key)))
          frontier(ctx, m.file.path, 'nonLiteralRegistration');
        continue;
      }
      for (const el of p.value.elements ?? []) {
        if (key === 'imports') {
          if (el?.type === 'Identifier') {
            const local = findClass(ctx, m.file, String(el.name));
            if (local) visitModule(local);
            else frontier(ctx, m.file.path, 'externalModule');
          } else frontier(ctx, m.file.path, 'dynamicModule');
        } else if (key === 'controllers') {
          const c = el?.type === 'Identifier' ? findClass(ctx, m.file, String(el.name)) : null;
          if (c) controllers.set(`${c.file.path}::${c.node.id?.name}`, c);
          else frontier(ctx, m.file.path, 'controllerUnresolved');
        } else if (key === 'providers' && el?.type === 'ObjectExpression') {
          const prop = (n: string) =>
            (el.properties ?? []).find(
              (q: AstNode) => q.type === 'Property' && !q.computed && (q.key?.name ?? q.key?.value) === n,
            );
          const provide = prop('provide')?.value;
          const pref = refName(provide);
          const token = pref ? resolveRef(m.file, pref) : null;
          const stage = token && token.module === '@nestjs/core' ? APP_TOKENS[token.name] : undefined;
          if (!stage) continue; // an ordinary provider; it registers nothing in the request chain
          const useClass = prop('useClass')?.value;
          if (!useClass || prop('useFactory') || prop('useValue') || prop('useExisting')) {
            frontier(ctx, m.file.path, 'unknownFactory');
            continue;
          }
          const b = classify(ctx, m.file, useClass, stage, 'global', 'app-provider');
          if (b) globals.push(b);
          else frontier(ctx, m.file.path, 'spanUnavailable');
        }
      }
    }
  };
  if (rootModule) visitModule(rootModule);

  // 4. Surfaces: route nodes of the parser graph and the controller method each calls.
  const surfaces: NestSurface[] = [];
  const routes = new Set(input.graph.nodes.filter((n) => n.kind === 'route').map((n) => n.id));
  const prefix = `${input.graph.repo ?? input.sourceId}::`;
  const handlersOf = new Map<string, string[]>();
  for (const e of input.graph.edges)
    if (e.kind === 'calls' && routes.has(e.from)) handlersOf.set(e.from, [...(handlersOf.get(e.from) ?? []), e.to]);
  const resolved: string[] = [];
  for (const [route, targets] of [...handlersOf].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // The route's handler: the called method of a class this source decorates with @Controller. Other calls (a
    // delegate the method returns into) are the parser's structure, not the surface.
    let hit: { path: string; className: string; method: string; file: ParsedFile; cls: AstNode; meth: AstNode } | null =
      null;
    for (const to of targets) {
      if (!to.startsWith(prefix)) continue;
      const rest = to.slice(prefix.length);
      const cut = rest.lastIndexOf('::');
      if (cut < 0) continue;
      const path = rest.slice(0, cut),
        [className, method, extra] = rest.slice(cut + 2).split('.');
      if (!className || !method || extra !== undefined) continue;
      const file = ctx.files.get(path);
      const cls = file ? classesOf(file).find((c) => c.id?.name === className) : undefined;
      if (!file || !cls || !decoratorsNamed(file, cls).some((d) => d.name === 'Controller')) continue;
      const meth = cls.body?.body?.find(
        (x: AstNode) => x.type === 'MethodDefinition' && !x.computed && x.key?.name === method,
      );
      if (!meth) continue;
      hit = { path, className, method, file, cls, meth };
      break;
    }
    if (!hit) {
      ctx.frontiers.push({ scopeId: route, reasonCode: R('surfaceUnresolved') });
      continue;
    }
    const { path, className, method, file, cls, meth } = hit;
    resolved.push(`${path}::${className}`);
    const local: NestReasonCode[] = [];
    if (!controllers.has(`${path}::${className}`)) local.push(R('controllerNotRegistered'));
    if (cls.superClass) local.push(R('inheritedController'));
    const chain: NestBinding[] = [...globals];
    // Decorators apply bottom to top, and each UseGuards / UseInterceptors / UsePipes appends to what the ones below it
    // registered (extendArrayMetadata), so a scope's stacked decorators register in reverse source order; the
    // arguments of one decorator keep their order.
    const take = (decs: ReturnType<typeof decoratorsNamed>, scope: NestScope) => {
      for (const d of [...decs].reverse()) {
        if (d.name && STAGE_OF[d.name]) {
          for (const a of d.args) {
            if (a.type === 'SpreadElement') {
              local.push(R('nonLiteralRegistration'));
              continue;
            }
            const b = classify(ctx, file, a, STAGE_OF[d.name]!, scope, 'decorator');
            if (b) chain.push(b);
            else local.push(R('spanUnavailable'));
          }
        } else if (!d.name || !KNOWN_DECORATORS.has(d.name)) local.push(R('customDecorator'));
      }
    };
    take(decoratorsNamed(file, cls), 'controller');
    take(decoratorsNamed(file, meth), 'method');
    const inputs: NestInput[] = [];
    (meth.value?.params ?? []).forEach((param: AstNode, index: number) => {
      for (const d of decoratorsNamed(file, param)) {
        if (!d.name) {
          local.push(R('customDecorator'));
          continue;
        }
        if (!PARAM_DECORATORS.has(d.name)) {
          local.push(R('customDecorator'));
          continue;
        }
        for (const a of d.args) {
          if (a.type === 'Literal' || a.type === 'StringLiteral') continue; // the property name: @Body('field')
          const b = classify(ctx, file, a, 'pipe', 'parameter', 'parameter', index);
          if (b) chain.push(b);
          else local.push(R('spanUnavailable'));
        }
        if (!INPUT_DECORATORS.has(d.name)) continue;
        const typeName = typeNameOf(param);
        const dtoClass =
          typeName && !['string', 'number', 'boolean'].includes(typeName) ? findClass(ctx, file, typeName) : null;
        // The parameter with its decorators: what the handler declares it receives.
        const ev = evidenceOf(ctx, file, {
          type: 'Span',
          start: Math.min(param.start, ...(param.decorators ?? []).map((x: AstNode) => x.start)),
          end: param.end,
        });
        if (!ev) {
          local.push(R('spanUnavailable'));
          continue;
        }
        inputs.push({
          index,
          decorator: d.name,
          typeName,
          evidence: ev,
          dto: dtoClass
            ? { name: typeName!, relativePath: dtoClass.file.path, ...dtoRules(dtoClass.file, dtoClass.node) }
            : null,
        });
      }
    });
    chain.sort((a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]);
    surfaces.push({
      surfaceId: route,
      controller: className!,
      handler: method!,
      relativePath: path!,
      chain,
      inputs,
      frontiers: [...new Set(local)],
    });
  }
  for (const [key, c] of controllers)
    if (!resolved.includes(key)) frontier(ctx, c.file.path, 'controllerWithoutRoutes');

  // 5. Facts, under the versions of the projects that own the bootstrap, the controllers and their inputs.
  const owned = [
    ...(boot ? [boot.file.path] : []),
    ...surfaces.map((x) => x.relativePath),
    ...surfaces.flatMap((s) =>
      s.chain.filter((b) => b.origin.startsWith('@nestjs/')).map((b) => b.evidence.relativePath),
    ),
  ];
  // The constructor's import belongs to its registration file (a bootstrap/module for a global pipe), not to each
  // controller it later reaches. Every validator on an input must share the DTO's supported class-validator copy.
  const validatorPairs = surfaces.flatMap((s) =>
    s.inputs.flatMap((i) =>
      i.dto
        ? s.chain
            .filter(
              (b) =>
                b.stage === 'pipe' && b.effect === 'validation' && (b.scope !== 'parameter' || b.parameter === i.index),
            )
            .map((b) => [b.evidence.relativePath, i.dto!.relativePath] as const)
        : [],
    ),
  );
  const framework = await versions(ctx, owned, validatorPairs);
  const versionKnown = framework.version !== null;
  const globalFrontiers = ctx.frontiers
    .filter((f) =>
      (
        [
          'versionUnresolved',
          'versionUnsupported',
          'bootstrapNotFound',
          'bootstrapAmbiguous',
          'rootModuleUnresolved',
          'applicationUnresolved',
          'middlewareNotModeled',
          'nonLiteralRegistration',
          'dynamicModule',
          'externalModule',
          'unknownFactory',
          'moduleUnresolved',
          'bootstrapNotInvoked',
          'applicationEscapes',
          'registrationNotFollowed',
          'applicationMutated',
          'frameworkMutated',
          'frameworkEscapes',
          'controllerUnresolved',
          'parseFailed',
          'invalidUtf8',
          'fileNotRead',
          'fileNotCaptured',
          'spanUnavailable',
        ] as NestReason[]
      )
        .map(R)
        .includes(f.reasonCode as NestReasonCode),
    )
    .map((f) => f.reasonCode);
  const facts: ControlFact[] = [];
  const add = (
    s: NestSurface,
    property: ControlFact['property'],
    order: number,
    verdict: ControlFact['verdict'],
    evidence: SourceEvidence[],
    reasonCode?: string,
  ) => {
    if (verdict !== 'unknown' && !versionKnown) {
      verdict = 'unknown';
      reasonCode = globalFrontiers[0] ?? R('versionUnresolved');
      evidence = [];
    }
    facts.push({
      id: `nest-${sha256Hex(`${s.surfaceId}\u0000${property}\u0000${order}`).slice(0, 32)}`,
      property,
      surfaceId: s.surfaceId,
      order,
      verdict,
      evidence: verdict === 'unknown' ? [] : evidence.slice(0, 64),
      ...(verdict === 'unknown' ? { reasonCode: reasonCode! } : {}),
    });
  };
  const metadataCache = new Map<string, Metadata>();
  for (const s of surfaces) {
    const blockers = [...globalFrontiers, ...s.frontiers];
    const guards = s.chain.filter((b) => b.stage === 'guard');
    const interceptorsUnknown = s.chain.filter((b) => b.stage === 'interceptor' && b.effect === 'unknown');
    const anchor = bootstrapEvidence ? [bootstrapEvidence] : [];
    // Access control: a guard's effect is never inferred; with no guard and nothing unknown in the chain, none applies.
    for (const property of ['authentication', 'authorization'] as const) {
      if (guards.length) add(s, property, s.chain.indexOf(guards[0]!), 'unknown', [], R('guardEffectUnresolved'));
      else if (blockers.length) add(s, property, 0, 'unknown', [], blockers[0]);
      else if (interceptorsUnknown.length)
        add(s, property, s.chain.indexOf(interceptorsUnknown[0]!), 'unknown', [], R('interceptorEffectUnresolved'));
      else add(s, property, 0, 'does-not-apply', anchor);
    }
    // Input validation, for surfaces with a class-typed or uploaded input.
    const validated = s.inputs.filter(
      (i) =>
        i.dto ||
        i.decorator === 'UploadedFile' ||
        i.decorator === 'UploadedFiles' ||
        (i.typeName && !['string', 'number', 'boolean'].includes(i.typeName)),
    );
    if (!validated.length) continue;
    const pipesFor = (i: NestInput) =>
      s.chain.filter((b) => b.stage === 'pipe' && (b.scope !== 'parameter' || b.parameter === i.index));
    const validators = (i: NestInput) => pipesFor(i).filter((b) => b.effect === 'validation');
    const unknownPipes = (i: NestInput) => pipesFor(i).filter((b) => b.effect === 'unknown');
    const allCovered = validated.every((i) => validators(i).length > 0);
    if (allCovered) {
      // Another pipe on the same input, or a registration the pack cannot see, could replace the value it validates.
      const reasons: string[] = [...blockers];
      if (validated.some((i) => unknownPipes(i).length)) reasons.push(R('pipeEffectUnresolved'));
      // An interceptor runs before the pipes and can answer without calling the handler (and so without them).
      if (interceptorsUnknown.length) reasons.push(R('interceptorEffectUnresolved'));
      if (validated.some((i) => validators(i).some((v) => !v.optionsKnown)))
        reasons.push(R('validationOptionsUnknown'));
      if (validated.some((i) => !i.dto)) reasons.push(R('dtoUnresolved'));
      if (validated.some((i) => i.dto?.conditional)) reasons.push(R('dtoConditional'));
      if (validated.some((i) => i.dto && i.dto.rules === 0)) reasons.push(R('dtoWithoutRules'));
      if (validated.some((i) => i.dto?.inherited)) reasons.push(R('dtoInherited'));
      if (
        validated.some(
          (i) =>
            i.dto &&
            validators(i).some(
              (v) =>
                framework.classValidatorFor(v.evidence.relativePath, i.dto!.relativePath) !==
                NEST_PACK.versions['class-validator'],
            ),
        )
      )
        reasons.push(R('classValidatorUnsupported'));
      const metadata = await decoratorMetadata(ctx, s.relativePath, metadataCache);
      if (metadata.state === 'off') reasons.push(R('decoratorMetadataOff'));
      if (metadata.state === 'unknown') reasons.push(R('decoratorMetadataUnknown'));
      const first = validators(validated[0]!)[0]!;
      if (reasons.length) add(s, 'input-validation', s.chain.indexOf(first), 'unknown', [], reasons[0]);
      else
        add(s, 'input-validation', s.chain.indexOf(first), 'applies', [
          ...new Set(validated.flatMap((i) => [validators(i)[0]!.evidence, i.evidence])),
          metadata.evidence!,
        ]);
    } else if (validated.some((i) => validators(i).length === 0 && unknownPipes(i).length)) {
      add(
        s,
        'input-validation',
        s.chain.indexOf(unknownPipes(validated.find((i) => unknownPipes(i).length)!)[0]!),
        'unknown',
        [],
        R('pipeEffectUnresolved'),
      );
    } else if (blockers.length) {
      add(s, 'input-validation', 0, 'unknown', [], blockers[0]);
    } else if (interceptorsUnknown.length || guards.length) {
      // Code the pack does not model can inspect and refuse the input itself: no is not established.
      const b = interceptorsUnknown[0] ?? guards[0]!;
      add(
        s,
        'input-validation',
        s.chain.indexOf(b),
        'unknown',
        [],
        interceptorsUnknown.length ? R('interceptorEffectUnresolved') : R('guardEffectUnresolved'),
      );
    } else {
      // Nothing in the chain validates these inputs; a multipart interceptor only parses them.
      const parsers = s.chain.filter((b) => b.effect === 'parsing').map((b) => b.evidence);
      add(s, 'input-validation', 0, 'does-not-apply', [
        ...anchor,
        ...validated.filter((i) => validators(i).length === 0).map((i) => i.evidence),
        ...parsers,
      ]);
    }
  }

  const registrations = [
    ...globals.map((b) => b.evidence),
    ...surfaces.flatMap((s) => s.chain.filter((b) => b.scope !== 'global').map((b) => b.evidence)),
    ...(bootstrapEvidence ? [bootstrapEvidence] : []),
  ].map((e) => ({ path: e.relativePath, content: e.content, span: e.span, quote: e.quoteDigest }));
  const controls: ControlFactsEnvelope = {
    schema: 'sentinel-controls/draft-1',
    snapshotId: input.snapshot.id,
    framework: { id: 'nest', version: framework.version },
    packDigest: canonicalDigest({ kind: 'sentinel-framework-pack/1', pack: NEST_PACK }),
    environmentDigest: canonicalDigest({
      kind: 'sentinel-nest-environment/2',
      framework: {
        version: framework.version,
        provenance: framework.provenance,
        classValidator: framework.classValidator,
      },
    }),
    registrationDigest: canonicalDigest({ kind: 'sentinel-nest-registrations/1', registrations }),
    capability: 'framework-order',
    facts: facts.sort((a, b) =>
      a.surfaceId < b.surfaceId
        ? -1
        : a.surfaceId > b.surfaceId
          ? 1
          : a.property < b.property
            ? -1
            : a.property > b.property
              ? 1
              : 0,
    ),
    frontiers: [
      ...ctx.frontiers,
      ...surfaces.flatMap((s) => s.frontiers.map((reasonCode) => ({ scopeId: s.surfaceId, reasonCode }))),
    ].sort((a, b) => (a.scopeId + a.reasonCode < b.scopeId + b.reasonCode ? -1 : 1)),
  };
  const checked = validateEnvelope('controls', controls);
  if (!checked.ok) throw new NestPackError(`${checked.errors[0]?.path} ${checked.errors[0]?.message}`);
  const scope: NestScopeReport = {
    schema: 'sentinel-nest-scope/draft-1',
    snapshotId: input.snapshot.id,
    sourceId: input.sourceId,
    framework: {
      version: framework.version,
      provenance: framework.provenance,
      classValidator: framework.classValidator,
    },
    globals,
    surfaces: surfaces.sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1)),
    frontiers: controls.frontiers,
  };
  return deepFreeze({ controls, scope });
}
