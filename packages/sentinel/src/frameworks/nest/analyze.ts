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
import { createHash } from 'node:crypto';
import type { ArtifactId, ScopedReason, SourceEvidence } from '../../contracts/common.js';
import type { ControlFact, ControlFactsEnvelope } from '../../contracts/controls.js';
import type { SnapshotEnvelope } from '../../contracts/snapshot.js';
import { canonicalDigest } from '../../policy/digest.js';
import { deepFreeze } from '../../policy/immutable.js';
import { validateEnvelope } from '../../validate.js';
import { NEST_PACK } from './support.js';
import { NestPackError, type NestReason, type NestReasonCode } from './errors.js';
import {
  classesOf, decoratorCall, loadParser, parseFile, refName, resolveRef, SyntaxFailure, walk,
  type AstNode, type ParsedFile, type Span,
} from './syntax.js';

export type NestStage = 'guard' | 'interceptor' | 'pipe';
export type NestScope = 'global' | 'controller' | 'method' | 'parameter';
/** What a binding does. `access-control-unresolved`: a guard, whose effect is never inferred. */
export type NestEffect = 'validation' | 'parsing' | 'transformation' | 'access-control-unresolved' | 'unknown';

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

export interface NestInput {
  readonly index: number;
  readonly decorator: string;
  /** The parameter's annotated class, when it is one this pack resolved. */
  readonly dto: { readonly name: string; readonly relativePath: string; readonly rules: number } | null;
  readonly typeName: string | null;
  readonly evidence: SourceEvidence;
}

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

export interface NestScopeReport {
  readonly schema: 'sentinel-nest-scope/draft-1';
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly framework: { readonly version: string | null; readonly provenance: string | null; readonly classValidator: string | null };
  readonly globals: readonly NestBinding[];
  readonly surfaces: readonly NestSurface[];
  readonly frontiers: readonly ScopedReason[];
}

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

export interface NestAnalysisInput {
  readonly snapshot: SnapshotEnvelope;
  readonly sourceId: string;
  readonly graph: ParserGraph;
  /** Captured bytes by artifact id (the store's verified read). */
  readArtifact(id: ArtifactId): Promise<Uint8Array>;
  readonly limits?: { readonly maxFiles?: number; readonly maxFileBytes?: number };
}

const R = (code: NestReason): NestReasonCode => `sentinel.nest.${code}` as NestReasonCode;
const sha256 = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const VERBS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All']);
const KNOWN_DECORATORS = new Set(['Controller', 'UseGuards', 'UseInterceptors', 'UsePipes', 'HttpCode', 'Header', 'Redirect', 'Render', ...VERBS]);
const PARAM_DECORATORS = new Set(['Body', 'Query', 'Param', 'Headers', 'Req', 'Request', 'Res', 'Response', 'Ip', 'UploadedFile', 'UploadedFiles', 'Session', 'HostParam', 'Next']);
const INPUT_DECORATORS = new Set(['Body', 'Query', 'Param', 'UploadedFile', 'UploadedFiles']);
const PARSE_PIPES = new Set(['ParseIntPipe', 'ParseFloatPipe', 'ParseBoolPipe', 'ParseArrayPipe', 'ParseUUIDPipe', 'ParseEnumPipe', 'ParseFilePipe']);
const MULTIPART = new Set(['FileInterceptor', 'FilesInterceptor', 'FileFieldsInterceptor', 'AnyFilesInterceptor', 'NoFilesInterceptor']);
const STAGE_OF: Record<string, NestStage> = { UseGuards: 'guard', UseInterceptors: 'interceptor', UsePipes: 'pipe', useGlobalGuards: 'guard', useGlobalInterceptors: 'interceptor', useGlobalPipes: 'pipe' };
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
    snapshotId: ctx.input.snapshot.id, sourceId: ctx.input.sourceId, relativePath: file.path, content: ctx.content.get(file.path)!,
    span, quoteDigest: sha256(bytes),
  };
}

const frontier = (ctx: Ctx, path: string, code: NestReason) => {
  const scopeId = `${ctx.input.sourceId}:${path}`;
  if (!ctx.frontiers.some(f => f.scopeId === scopeId && f.reasonCode === R(code))) ctx.frontiers.push({ scopeId, reasonCode: R(code) });
};

/** Resolves a relative import to a captured file path. */
function resolveModule(from: string, spec: string, files: Map<string, ParsedFile>): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
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
    const c = classesOf(tf).find(c => c.id?.name === imp.imported);
    return c ? { file: tf, node: c } : null;
  }
  const c = classesOf(file).find(c => c.id?.name === local);
  return c ? { file, node: c } : null;
}

/** One registration argument: what it is and where it comes from. */
function classify(ctx: Ctx, file: ParsedFile, arg: AstNode, stage: NestStage, scope: NestScope, registeredBy: NestBinding['registeredBy'], parameter?: number): NestBinding | null {
  const ev = evidenceOf(ctx, file, arg);
  if (!ev) return null;
  let target: AstNode | undefined = arg;
  let call = false;
  if (arg.type === 'NewExpression') target = arg.callee;
  else if (arg.type === 'CallExpression') { target = arg.callee; call = true; }
  const ref = refName(target);
  const base = { stage, scope, registeredBy, evidence: ev, ...(parameter !== undefined ? { parameter } : {}) };
  if (!ref || (arg.type !== 'Identifier' && arg.type !== 'NewExpression' && arg.type !== 'CallExpression' && arg.type !== 'MemberExpression' && arg.type !== 'StaticMemberExpression')) {
    return { ...base, name: '(expression)', origin: 'unresolved', effect: 'unknown', optionsKnown: false };
  }
  const r = resolveRef(file, ref);
  const name = r.name;
  if (r.module === '@nestjs/common') {
    const literalOptions = (arg.arguments ?? []).every((a: AstNode) => a.type === 'ObjectExpression' && (a.properties ?? []).every((p: AstNode) => p.type === 'Property' && !p.computed && !p.method && ['Literal', 'BooleanLiteral', 'NumericLiteral', 'StringLiteral'].includes(p.value?.type)));
    if (name === 'ValidationPipe' && stage === 'pipe' && !call) return { ...base, name, origin: '@nestjs/common', effect: 'validation', optionsKnown: literalOptions };
    if (PARSE_PIPES.has(name) && stage === 'pipe' && !call) return { ...base, name, origin: '@nestjs/common', effect: 'parsing', optionsKnown: literalOptions };
    if ((name === 'DefaultValuePipe' && stage === 'pipe') || (name === 'ClassSerializerInterceptor' && stage === 'interceptor')) return { ...base, name, origin: '@nestjs/common', effect: 'transformation', optionsKnown: literalOptions };
    return { ...base, name, origin: '@nestjs/common', effect: stage === 'guard' ? 'access-control-unresolved' : 'unknown', optionsKnown: false };
  }
  if (r.module === '@nestjs/platform-express' && MULTIPART.has(name) && stage === 'interceptor' && call) {
    return { ...base, name, origin: '@nestjs/platform-express', effect: 'parsing', optionsKnown: true };
  }
  if (r.module === null || r.module.startsWith('.')) {
    const local = call ? null : findClass(ctx, file, ref.local);
    if (local) return { ...base, name, origin: 'local', effect: stage === 'guard' ? 'access-control-unresolved' : 'unknown', optionsKnown: false };
    return { ...base, name, origin: 'unresolved', effect: stage === 'guard' ? 'access-control-unresolved' : 'unknown', optionsKnown: false };
  }
  return { ...base, name, origin: 'external', effect: stage === 'guard' ? 'access-control-unresolved' : 'unknown', optionsKnown: false };
}

function decoratorsNamed(file: ParsedFile, node: AstNode): { name: string | null; module: string | null; d: AstNode; args: AstNode[] }[] {
  return (node.decorators ?? []).map((d: AstNode) => {
    const { callee, args } = decoratorCall(d);
    const ref = refName(callee);
    if (!ref) return { name: null, module: null, d, args };
    const r = resolveRef(file, ref);
    return { name: r.module === '@nestjs/common' ? r.name : null, module: r.module, d, args };
  });
}

/** The class-validator rules a DTO class declares on its properties. */
function dtoRules(file: ParsedFile, cls: AstNode): number {
  let rules = 0;
  for (const m of cls.body?.body ?? []) {
    for (const d of m.decorators ?? []) {
      const ref = refName(decoratorCall(d).callee);
      if (ref && resolveRef(file, ref).module === 'class-validator') rules++;
    }
  }
  return rules;
}

function typeNameOf(param: AstNode): string | null {
  const id = param.type === 'TSParameterProperty' ? param.parameter : param;
  const ann = id?.typeAnnotation?.typeAnnotation;
  if (ann?.type === 'TSTypeReference' && ann.typeName?.type === 'Identifier') return String(ann.typeName.name);
  return null;
}

/** Versions of the Nest packages and class-validator, from the captured lockfile first, else exact manifest pins. */
async function versions(ctx: Ctx): Promise<NestScopeReport['framework']> {
  const read = async (path: string) => {
    const id = ctx.content.get(path);
    if (!id) return null;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await ctx.input.readArtifact(id))); } catch { return null; }
  };
  const lock = await read('package-lock.json');
  const pkg = await read('package.json');
  const pick = (name: string): { version: string; provenance: string } | null => {
    const locked = lock?.packages?.[`node_modules/${name}`]?.version;
    if (typeof locked === 'string' && EXACT.test(locked)) return { version: locked, provenance: 'package-lock.json' };
    const declared = pkg?.dependencies?.[name];
    if (typeof declared === 'string' && EXACT.test(declared)) return { version: declared, provenance: 'package.json (exact pin)' };
    return null;
  };
  const common = pick('@nestjs/common'), core = pick('@nestjs/core'), cv = pick('class-validator');
  const ok = common && core && common.version === NEST_PACK.versions['@nestjs/common'] && core.version === NEST_PACK.versions['@nestjs/core'];
  if (!common || !core) frontier(ctx, 'package.json', 'versionUnresolved');
  else if (!ok) frontier(ctx, 'package.json', 'versionUnsupported');
  return { version: ok ? common!.version : null, provenance: ok ? common!.provenance : null, classValidator: cv?.version ?? null };
}

export async function analyzeNest(input: NestAnalysisInput): Promise<NestAnalysis> {
  const maxFiles = input.limits?.maxFiles ?? 2000;
  const maxFileBytes = input.limits?.maxFileBytes ?? 1024 * 1024;
  const ctx: Ctx = { input, files: new Map(), content: new Map(), frontiers: [] };
  // 1. The captured TypeScript of this source, parsed from the store's bytes.
  await loadParser();
  const entries = input.snapshot.entries.filter(e => e.sourceId === input.sourceId && e.kind === 'file' && e.disposition === 'included');
  for (const e of entries) if (e.kind === 'file' && e.disposition === 'included') ctx.content.set(e.relativePath, e.content);
  let read = 0;
  for (const e of entries) {
    if (e.kind !== 'file' || e.disposition !== 'included' || !/\.tsx?$/.test(e.relativePath) || e.relativePath.endsWith('.d.ts')) continue;
    if (/(^|\/)node_modules\//.test(e.relativePath)) continue;
    if (++read > maxFiles || e.bytes > maxFileBytes) { frontier(ctx, e.relativePath, 'fileNotRead'); continue; }
    try { ctx.files.set(e.relativePath, parseFile(e.relativePath, await input.readArtifact(e.content))); } catch (err) {
      frontier(ctx, e.relativePath, err instanceof SyntaxFailure && err.reason === 'invalidUtf8' ? 'invalidUtf8' : 'parseFailed');
    }
  }
  // Files the capture recorded without bytes may hold registrations: each is a frontier.
  for (const e of input.snapshot.entries) {
    if (e.sourceId === input.sourceId && e.kind === 'file' && e.disposition !== 'included' && /\.tsx?$/.test(e.relativePath)) frontier(ctx, e.relativePath, 'fileNotCaptured');
  }
  const framework = await versions(ctx);

  // 2. The bootstrap: exactly one NestFactory.create(Module) and the application's global registrations.
  const globals: NestBinding[] = [];
  let rootModule: { file: ParsedFile; node: AstNode } | null = null;
  let bootstrapEvidence: SourceEvidence | null = null;
  const creates: { file: ParsedFile; call: AstNode; app: string | null }[] = [];
  for (const file of ctx.files.values()) {
    walk(file.program, n => {
      if (n.type !== 'VariableDeclarator' && n.type !== 'ExpressionStatement' && n.type !== 'AssignmentExpression') return;
      const init = n.type === 'VariableDeclarator' ? n.init : n.type === 'AssignmentExpression' ? n.right : n.expression;
      const call = init?.type === 'AwaitExpression' ? init.argument : init;
      if (call?.type !== 'CallExpression') return;
      const ref = refName(call.callee);
      if (!ref || ref.member !== 'create' || resolveRef(file, { local: ref.local }).module !== '@nestjs/core' || resolveRef(file, { local: ref.local }).name !== 'NestFactory') return;
      const app = n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' ? String(n.id.name) : n.type === 'AssignmentExpression' && n.left?.type === 'Identifier' ? String(n.left.name) : null;
      creates.push({ file, call, app });
      return false;
    });
  }
  if (creates.length !== 1) frontier(ctx, creates[1]?.file.path ?? 'main.ts', creates.length ? 'bootstrapAmbiguous' : 'bootstrapNotFound');
  const boot = creates.length === 1 ? creates[0]! : null;
  if (boot) {
    bootstrapEvidence = evidenceOf(ctx, boot.file, boot.call);
    const arg = boot.call.arguments?.[0];
    const ref = arg?.type === 'Identifier' ? refName(arg) : null;
    rootModule = ref ? findClass(ctx, boot.file, ref.local) : null;
    if (!rootModule) frontier(ctx, boot.file.path, 'rootModuleUnresolved');
    if (!boot.app) frontier(ctx, boot.file.path, 'applicationUnresolved');
    walk(boot.file.program, n => {
      if (n.type !== 'CallExpression') return;
      const ref = refName(n.callee);
      if (!ref || !boot.app || ref.local !== boot.app || !ref.member) return;
      if (ref.member === 'use') { frontier(ctx, boot.file.path, 'middlewareNotModeled'); return; }
      // A handler mounted on the HTTP adapter runs outside Nest's chain; it is not one of the controller surfaces.
      if (ref.member === 'getHttpAdapter') { frontier(ctx, boot.file.path, 'adapterRouteNotModeled'); return; }
      const stage = STAGE_OF[ref.member];
      if (!stage) return;
      for (const a of n.arguments ?? []) {
        if (a.type === 'SpreadElement') { frontier(ctx, boot.file.path, 'nonLiteralRegistration'); continue; }
        const b = classify(ctx, boot.file, a, stage, 'global', 'use-global');
        if (b) globals.push(b); else frontier(ctx, boot.file.path, 'spanUnavailable');
      }
    });
  }

  // 3. The module graph from the root module: controllers, global providers, and what cannot be followed.
  const controllers = new Map<string, { file: ParsedFile; node: AstNode }>();
  const seen = new Set<string>();
  const visitModule = (m: { file: ParsedFile; node: AstNode }) => {
    const key = `${m.file.path}::${m.node.id?.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const dec = decoratorsNamed(m.file, m.node).find(d => d.name === 'Module');
    const meta = dec?.args[0];
    if (!dec || meta?.type !== 'ObjectExpression') { frontier(ctx, m.file.path, 'moduleUnresolved'); return; }
    for (const p of meta.properties ?? []) {
      const key = p.type === 'Property' && !p.computed ? String(p.key?.name ?? p.key?.value) : null;
      if (!key || p.value?.type !== 'ArrayExpression') { if (p.type === 'SpreadElement' || (key && ['imports', 'providers', 'controllers'].includes(key))) frontier(ctx, m.file.path, 'nonLiteralRegistration'); continue; }
      for (const el of p.value.elements ?? []) {
        if (key === 'imports') {
          if (el?.type === 'Identifier') {
            const local = findClass(ctx, m.file, String(el.name));
            if (local) visitModule(local); else frontier(ctx, m.file.path, 'externalModule');
          } else frontier(ctx, m.file.path, 'dynamicModule');
        } else if (key === 'controllers') {
          const c = el?.type === 'Identifier' ? findClass(ctx, m.file, String(el.name)) : null;
          if (c) controllers.set(`${c.file.path}::${c.node.id?.name}`, c); else frontier(ctx, m.file.path, 'controllerUnresolved');
        } else if (key === 'providers' && el?.type === 'ObjectExpression') {
          const prop = (n: string) => (el.properties ?? []).find((q: AstNode) => q.type === 'Property' && !q.computed && (q.key?.name ?? q.key?.value) === n);
          const provide = prop('provide')?.value;
          const pref = refName(provide);
          const token = pref ? resolveRef(m.file, pref) : null;
          const stage = token && token.module === '@nestjs/core' ? APP_TOKENS[token.name] : undefined;
          if (!stage) continue; // an ordinary provider; it registers nothing in the request chain
          const useClass = prop('useClass')?.value;
          if (!useClass || prop('useFactory') || prop('useValue') || prop('useExisting')) { frontier(ctx, m.file.path, 'unknownFactory'); continue; }
          const b = classify(ctx, m.file, useClass, stage, 'global', 'app-provider');
          if (b) globals.push(b); else frontier(ctx, m.file.path, 'spanUnavailable');
        }
      }
    }
  };
  if (rootModule) visitModule(rootModule);

  // 4. Surfaces: route nodes of the parser graph and the controller method each calls.
  const surfaces: NestSurface[] = [];
  const routes = new Set(input.graph.nodes.filter(n => n.kind === 'route').map(n => n.id));
  const prefix = `${input.graph.repo ?? input.sourceId}::`;
  const handlersOf = new Map<string, string[]>();
  for (const e of input.graph.edges) if (e.kind === 'calls' && routes.has(e.from)) handlersOf.set(e.from, [...(handlersOf.get(e.from) ?? []), e.to]);
  const resolved: string[] = [];
  for (const [route, targets] of [...handlersOf].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // The route's handler: the called method of a class this source decorates with @Controller. Other calls (a
    // delegate the method returns into) are the parser's structure, not the surface.
    let hit: { path: string; className: string; method: string; file: ParsedFile; cls: AstNode; meth: AstNode } | null = null;
    for (const to of targets) {
      if (!to.startsWith(prefix)) continue;
      const rest = to.slice(prefix.length);
      const cut = rest.lastIndexOf('::');
      if (cut < 0) continue;
      const path = rest.slice(0, cut), [className, method, extra] = rest.slice(cut + 2).split('.');
      if (!className || !method || extra !== undefined) continue;
      const file = ctx.files.get(path);
      const cls = file ? classesOf(file).find(c => c.id?.name === className) : undefined;
      if (!file || !cls || !decoratorsNamed(file, cls).some(d => d.name === 'Controller')) continue;
      const meth = cls.body?.body?.find((x: AstNode) => x.type === 'MethodDefinition' && !x.computed && x.key?.name === method);
      if (!meth) continue;
      hit = { path, className, method, file, cls, meth };
      break;
    }
    if (!hit) { ctx.frontiers.push({ scopeId: route, reasonCode: R('surfaceUnresolved') }); continue; }
    const { path, className, method, file, cls, meth } = hit;
    resolved.push(`${path}::${className}`);
    const local: NestReasonCode[] = [];
    if (!controllers.has(`${path}::${className}`)) local.push(R('controllerNotRegistered'));
    if (cls.superClass) local.push(R('inheritedController'));
    const chain: NestBinding[] = [...globals];
    const take = (decs: ReturnType<typeof decoratorsNamed>, scope: NestScope) => {
      for (const d of decs) {
        if (d.name && STAGE_OF[d.name]) {
          for (const a of d.args) {
            if (a.type === 'SpreadElement') { local.push(R('nonLiteralRegistration')); continue; }
            const b = classify(ctx, file, a, STAGE_OF[d.name]!, scope, 'decorator');
            if (b) chain.push(b); else local.push(R('spanUnavailable'));
          }
        } else if (!d.name || !KNOWN_DECORATORS.has(d.name)) local.push(R('customDecorator'));
      }
    };
    take(decoratorsNamed(file, cls), 'controller');
    take(decoratorsNamed(file, meth), 'method');
    const inputs: NestInput[] = [];
    (meth.value?.params ?? []).forEach((param: AstNode, index: number) => {
      for (const d of decoratorsNamed(file, param)) {
        if (!d.name) { local.push(R('customDecorator')); continue; }
        if (!PARAM_DECORATORS.has(d.name)) { local.push(R('customDecorator')); continue; }
        for (const a of d.args) {
          if (a.type === 'Literal' || a.type === 'StringLiteral') continue; // the property name: @Body('field')
          const b = classify(ctx, file, a, 'pipe', 'parameter', 'parameter', index);
          if (b) chain.push(b); else local.push(R('spanUnavailable'));
        }
        if (!INPUT_DECORATORS.has(d.name)) continue;
        const typeName = typeNameOf(param);
        const dtoClass = typeName && !['string', 'number', 'boolean'].includes(typeName) ? findClass(ctx, file, typeName) : null;
        // The parameter with its decorators: what the handler declares it receives.
        const ev = evidenceOf(ctx, file, { type: 'Span', start: Math.min(param.start, ...(param.decorators ?? []).map((x: AstNode) => x.start)), end: param.end });
        if (!ev) { local.push(R('spanUnavailable')); continue; }
        inputs.push({ index, decorator: d.name, typeName, evidence: ev, dto: dtoClass ? { name: typeName!, relativePath: dtoClass.file.path, rules: dtoRules(dtoClass.file, dtoClass.node) } : null });
      }
    });
    chain.sort((a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]);
    surfaces.push({ surfaceId: route, controller: className!, handler: method!, relativePath: path!, chain, inputs, frontiers: [...new Set(local)] });
  }
  for (const [key, c] of controllers) if (!resolved.includes(key)) frontier(ctx, c.file.path, 'controllerWithoutRoutes');

  // 5. Facts.
  const versionKnown = framework.version !== null;
  const globalFrontiers = ctx.frontiers.filter(f => ([
    'versionUnresolved', 'versionUnsupported', 'bootstrapNotFound', 'bootstrapAmbiguous', 'rootModuleUnresolved', 'applicationUnresolved',
    'middlewareNotModeled', 'nonLiteralRegistration', 'dynamicModule', 'externalModule', 'unknownFactory', 'moduleUnresolved',
    'controllerUnresolved', 'parseFailed', 'invalidUtf8', 'fileNotRead', 'fileNotCaptured', 'spanUnavailable',
  ] as NestReason[]).map(R).includes(f.reasonCode as NestReasonCode)).map(f => f.reasonCode);
  const facts: ControlFact[] = [];
  const add = (s: NestSurface, property: ControlFact['property'], order: number, verdict: ControlFact['verdict'], evidence: SourceEvidence[], reasonCode?: string) => {
    if (verdict !== 'unknown' && !versionKnown) { verdict = 'unknown'; reasonCode = globalFrontiers[0] ?? R('versionUnresolved'); evidence = []; }
    facts.push({
      id: `nest-${createHash('sha256').update(`${s.surfaceId}\u0000${property}\u0000${order}`).digest('hex').slice(0, 32)}`,
      property, surfaceId: s.surfaceId, order, verdict, evidence: verdict === 'unknown' ? [] : evidence.slice(0, 64),
      ...(verdict === 'unknown' ? { reasonCode: reasonCode! } : {}),
    });
  };
  for (const s of surfaces) {
    const blockers = [...globalFrontiers, ...s.frontiers];
    const guards = s.chain.filter(b => b.stage === 'guard');
    const interceptorsUnknown = s.chain.filter(b => b.stage === 'interceptor' && b.effect === 'unknown');
    const anchor = bootstrapEvidence ? [bootstrapEvidence] : [];
    // Access control: a guard's effect is never inferred; with no guard and nothing unknown in the chain, none applies.
    for (const property of ['authentication', 'authorization'] as const) {
      if (guards.length) add(s, property, s.chain.indexOf(guards[0]!), 'unknown', [], R('guardEffectUnresolved'));
      else if (blockers.length) add(s, property, 0, 'unknown', [], blockers[0]);
      else if (interceptorsUnknown.length) add(s, property, s.chain.indexOf(interceptorsUnknown[0]!), 'unknown', [], R('interceptorEffectUnresolved'));
      else add(s, property, 0, 'does-not-apply', anchor);
    }
    // Input validation, for surfaces with a class-typed or uploaded input.
    const validated = s.inputs.filter(i => i.dto || i.decorator === 'UploadedFile' || i.decorator === 'UploadedFiles' || (i.typeName && !['string', 'number', 'boolean'].includes(i.typeName)));
    if (!validated.length) continue;
    const pipesFor = (i: NestInput) => s.chain.filter(b => b.stage === 'pipe' && (b.scope !== 'parameter' || b.parameter === i.index));
    const validators = (i: NestInput) => pipesFor(i).filter(b => b.effect === 'validation');
    const unknownPipes = (i: NestInput) => pipesFor(i).filter(b => b.effect === 'unknown');
    const allCovered = validated.every(i => validators(i).length > 0);
    if (allCovered) {
      // Another pipe on the same input, or a registration the pack cannot see, could replace the value it validates.
      const reasons: string[] = [...blockers];
      if (validated.some(i => unknownPipes(i).length)) reasons.push(R('pipeEffectUnresolved'));
      if (validated.some(i => validators(i).some(v => !v.optionsKnown))) reasons.push(R('validationOptionsUnknown'));
      if (validated.some(i => !i.dto)) reasons.push(R('dtoUnresolved'));
      if (validated.some(i => i.dto && i.dto.rules === 0)) reasons.push(R('dtoWithoutRules'));
      if (framework.classValidator !== NEST_PACK.versions['class-validator']) reasons.push(R('classValidatorUnsupported'));
      const first = validators(validated[0]!)[0]!;
      if (reasons.length) add(s, 'input-validation', s.chain.indexOf(first), 'unknown', [], reasons[0]);
      else add(s, 'input-validation', s.chain.indexOf(first), 'applies', [...new Set(validated.flatMap(i => [validators(i)[0]!.evidence, i.evidence]))]);
    } else if (validated.some(i => validators(i).length === 0 && unknownPipes(i).length)) {
      add(s, 'input-validation', s.chain.indexOf(unknownPipes(validated.find(i => unknownPipes(i).length)!)[0]!), 'unknown', [], R('pipeEffectUnresolved'));
    } else if (blockers.length) {
      add(s, 'input-validation', 0, 'unknown', [], blockers[0]);
    } else {
      // Nothing in the chain validates these inputs; a multipart interceptor only parses them.
      const parsers = s.chain.filter(b => b.effect === 'parsing').map(b => b.evidence);
      add(s, 'input-validation', 0, 'does-not-apply', [...anchor, ...validated.filter(i => validators(i).length === 0).map(i => i.evidence), ...parsers]);
    }
  }

  const registrations = [...globals.map(b => b.evidence), ...surfaces.flatMap(s => s.chain.filter(b => b.scope !== 'global').map(b => b.evidence)), ...(bootstrapEvidence ? [bootstrapEvidence] : [])]
    .map(e => ({ path: e.relativePath, content: e.content, span: e.span, quote: e.quoteDigest }));
  const controls: ControlFactsEnvelope = {
    schema: 'sentinel-controls/draft-1', snapshotId: input.snapshot.id, framework: { id: 'nest', version: framework.version },
    packDigest: canonicalDigest({ kind: 'sentinel-framework-pack/1', pack: NEST_PACK }),
    environmentDigest: canonicalDigest({ kind: 'sentinel-nest-environment/1', framework }),
    registrationDigest: canonicalDigest({ kind: 'sentinel-nest-registrations/1', registrations }),
    capability: 'framework-order',
    facts: facts.sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : a.surfaceId > b.surfaceId ? 1 : a.property < b.property ? -1 : a.property > b.property ? 1 : 0)),
    frontiers: [...ctx.frontiers, ...surfaces.flatMap(s => s.frontiers.map(reasonCode => ({ scopeId: s.surfaceId, reasonCode })))].sort((a, b) => (a.scopeId + a.reasonCode < b.scopeId + b.reasonCode ? -1 : 1)),
  };
  const checked = validateEnvelope('controls', controls);
  if (!checked.ok) throw new NestPackError(`${checked.errors[0]?.path} ${checked.errors[0]?.message}`);
  const scope: NestScopeReport = {
    schema: 'sentinel-nest-scope/draft-1', snapshotId: input.snapshot.id, sourceId: input.sourceId, framework, globals,
    surfaces: surfaces.sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1)), frontiers: controls.frontiers,
  };
  return deepFreeze({ controls, scope });
}
