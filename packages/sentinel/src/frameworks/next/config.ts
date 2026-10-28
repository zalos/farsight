// Static reads of a Next middleware file's exports and of next.config (PR 14). Nothing here evaluates application
// code: the bytes are parsed with Oxc and only literal syntax is read. A value Next 14.2.25 would have to compute, or
// syntax this pack has not verified Next extracts the same way (`as const`, `satisfies`, identifiers), is `dynamic`,
// never guessed. Spans are zero-based, half-open UTF-8 byte offsets into the captured bytes.
/** A zero-based, half-open range of UTF-8 bytes in a captured file. */
export interface ByteRange {
  readonly startByte: number;
  readonly endByte: number;
}

type Ast = Record<string, unknown> & { type: string; start: number; end: number };

const isAst = (v: unknown): v is Ast => v !== null && typeof v === 'object' && typeof (v as Ast).type === 'string';

let parseSyncCache: ((file: string, text: string) => { program: unknown; errors: unknown[] }) | undefined;

/** Oxc is loaded on first use (a native binding): importing Sentinel starts nothing. */
async function parser(): Promise<(file: string, text: string) => { program: unknown; errors: unknown[] }> {
  if (!parseSyncCache) {
    const mod = await import('oxc-parser');
    parseSyncCache = (file, text) => mod.parseSync(file, text) as unknown as { program: unknown; errors: unknown[] };
  }
  return parseSyncCache;
}

/** The decoded text and a UTF-16 → UTF-8 offset map, or null when the bytes are not valid UTF-8. */
export class SourceText {
  readonly text: string;
  private constructor(text: string) {
    this.text = text;
  }
  static decode(bytes: Uint8Array): SourceText | null {
    try {
      return new SourceText(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
      return null;
    }
  }
  bytes(node: { start: number; end: number }): ByteRange {
    return {
      startByte: Buffer.byteLength(this.text.slice(0, node.start)),
      endByte: Buffer.byteLength(this.text.slice(0, node.end)),
    };
  }
}

async function program(file: string, src: SourceText): Promise<Ast | null> {
  const parse = await parser();
  let result: { program: unknown; errors: unknown[] };
  try {
    result = parse(file, src.text);
  } catch {
    return null;
  }
  if (result.errors.length) return null;
  // oxc-parser returns the program as an object or as JSON text depending on version.
  const prog = typeof result.program === 'string' ? (JSON.parse(result.program) as unknown) : result.program;
  return isAst(prog) ? prog : null;
}

// ---- literal values ----

/** A value read from literal syntax only: no identifier, call or computed expression is ever evaluated. */
export type Literal = string | number | boolean | null | readonly Literal[] | { readonly [k: string]: Literal };
type Eval = { ok: true; value: Literal } | { ok: false; at: Ast };

/** Only literal syntax: strings, numbers, booleans, null, expression-free templates, arrays and plain objects. */
function literal(node: unknown): Eval {
  if (!isAst(node)) return { ok: false, at: node as Ast };
  switch (node.type) {
    case 'Literal': {
      const v = node.value;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
        if ('regex' in node && node.regex) return { ok: false, at: node };
        return { ok: true, value: v };
      }
      return { ok: false, at: node };
    }
    case 'TemplateLiteral': {
      const quasis = node.quasis as Ast[];
      if ((node.expressions as unknown[]).length || quasis.length !== 1) return { ok: false, at: node };
      const cooked = (quasis[0]!.value as { cooked?: unknown }).cooked;
      return typeof cooked === 'string' ? { ok: true, value: cooked } : { ok: false, at: node };
    }
    case 'ArrayExpression': {
      const out: Literal[] = [];
      for (const el of node.elements as unknown[]) {
        const v = literal(el);
        if (!v.ok) return v;
        out.push(v.value);
      }
      return { ok: true, value: out };
    }
    case 'ObjectExpression': {
      const out: Record<string, Literal> = {};
      for (const p of node.properties as Ast[]) {
        if (p.type !== 'Property' || p.kind !== 'init' || p.computed || p.shorthand || p.method)
          return { ok: false, at: p };
        const key = keyName(p.key);
        if (key === null || Object.hasOwn(out, key)) return { ok: false, at: p };
        const v = literal(p.value);
        if (!v.ok) return v;
        out[key] = v.value;
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: false, at: node };
  }
}

function keyName(key: unknown): string | null {
  if (!isAst(key)) return null;
  if (key.type === 'Identifier' && typeof key.name === 'string') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

// ---- the middleware file ----

/** One matcher entry as written, with the bytes that say it. */
export interface MatcherEntry {
  readonly span: ByteRange;
  /** The `source` string, when the entry has one. */
  readonly source?: string;
  /** `has` or `missing` request conditions: the entry matches only some requests to a matched path. */
  readonly conditional: boolean;
  /** Keys outside Next's matcher object form, or a source that is not a string. */
  readonly invalid?: string;
}

/**
 * The middleware's `config` export: absent (every path), a static matcher, or a form the pack cannot read (unknown).
 */
export type MiddlewareConfig =
  /** No `config` export: Next's default matcher, every request path. */
  | { readonly state: 'absent' }
  | {
      readonly state: 'static';
      readonly span: ByteRange;
      /** null: the config has no `matcher` key, so the default applies. */
      readonly matcher: null | { readonly span: ByteRange; readonly entries: readonly MatcherEntry[] };
    }
  | {
      readonly state: 'dynamic' | 'invalid' | 'runtime-unsupported';
      readonly span?: ByteRange;
      readonly detail: string;
    };

/** The middleware file as the pack reads it: refused with its reason, or its export and config. */
export type MiddlewareRead =
  | {
      readonly ok: false;
      readonly reason: 'not-utf8' | 'parse-failed' | 'no-export' | 'export-ambiguous';
      readonly detail: string;
      readonly span?: ByteRange;
    }
  | {
      readonly ok: true;
      readonly exportSpan: ByteRange;
      readonly exportName: 'middleware' | 'default';
      readonly config: MiddlewareConfig;
    };

const CONFIG_KEYS = new Set(['matcher', 'runtime', 'regions', 'unstable_allowDynamic']);
const ENTRY_KEYS = new Set(['source', 'has', 'missing', 'locale']);
const EDGE_RUNTIMES = new Set(['edge', 'experimental-edge']);

/** Reads a middleware file's handler export and its `config` export, from captured bytes only. */
export async function readMiddleware(file: string, bytes: Uint8Array): Promise<MiddlewareRead> {
  const src = SourceText.decode(bytes);
  if (!src) return { ok: false, reason: 'not-utf8', detail: 'the middleware file is not valid UTF-8' };
  const prog = await program(file, src);
  if (!prog) return { ok: false, reason: 'parse-failed', detail: 'the middleware file does not parse' };
  let handler: { span: ByteRange; name: 'middleware' | 'default' } | undefined;
  let configDecl: Ast | undefined;
  let configOther: Ast | undefined;
  let starExport: Ast | undefined;
  const found = (name: string, at: Ast) => {
    if ((name === 'middleware' || name === 'default') && !handler) handler = { span: src.bytes(at), name };
  };
  for (const stmt of prog.body as Ast[]) {
    if (stmt.type === 'ExportDefaultDeclaration') {
      found('default', stmt);
      continue;
    }
    if (stmt.type === 'ExportAllDeclaration') {
      if (stmt.exportKind !== 'type') starExport ??= stmt;
      continue;
    }
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.exportKind === 'type') continue;
    const decl = stmt.declaration as Ast | null;
    if (decl) {
      if (decl.type === 'FunctionDeclaration' && isAst(decl.id)) found(String(decl.id.name), stmt);
      if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations as Ast[]) {
          if (!isAst(d.id) || d.id.type !== 'Identifier') continue;
          const name = String(d.id.name);
          found(name, stmt);
          if (name === 'config') {
            if (decl.kind === 'const') configDecl = d;
            else configOther = stmt;
          }
        }
      }
      continue;
    }
    for (const s of (stmt.specifiers as Ast[]) ?? []) {
      if (s.exportKind === 'type') continue;
      const exported = keyName(s.exported);
      if (exported === null) continue;
      found(exported, stmt);
      if (exported === 'config') configOther = stmt;
    }
  }
  if (!handler) {
    return starExport
      ? {
          ok: false,
          reason: 'export-ambiguous',
          detail: 'the handler may come from an `export *`',
          span: src.bytes(starExport),
        }
      : { ok: false, reason: 'no-export', detail: 'the file exports neither `middleware` nor a default handler' };
  }
  const ok = (config: MiddlewareConfig): MiddlewareRead => ({
    ok: true,
    exportSpan: handler!.span,
    exportName: handler!.name,
    config,
  });
  if (configOther)
    return ok({
      state: 'dynamic',
      span: src.bytes(configOther),
      detail: '`config` is not exported as a `const` declaration',
    });
  if (!configDecl) {
    return starExport
      ? ok({ state: 'dynamic', span: src.bytes(starExport), detail: '`config` may come from an `export *`' })
      : ok({ state: 'absent' });
  }
  const init = configDecl.init as Ast | null;
  const span = src.bytes(configDecl);
  if (!init || init.type !== 'ObjectExpression')
    return ok({ state: 'dynamic', span, detail: '`config` is not an object literal' });
  const value = literal(init);
  if (!value.ok)
    return ok({
      state: 'dynamic',
      span: isAst(value.at) ? src.bytes(value.at) : span,
      detail: 'part of `config` is not literal syntax',
    });
  const cfg = value.value as Record<string, Literal>;
  for (const k of Object.keys(cfg))
    if (!CONFIG_KEYS.has(k))
      return ok({ state: 'invalid', span, detail: `\`config.${k}\` is not a middleware option this pack reads` });
  if ('runtime' in cfg && !(typeof cfg.runtime === 'string' && EDGE_RUNTIMES.has(cfg.runtime))) {
    return ok({ state: 'runtime-unsupported', span, detail: 'only the edge middleware runtime is supported' });
  }
  if (!('matcher' in cfg)) return ok({ state: 'static', span, matcher: null });
  const mNode = (init.properties as Ast[]).find((p) => keyName(p.key) === 'matcher')!.value as Ast;
  const mSpan = src.bytes(mNode);
  const nodes: Ast[] = mNode.type === 'ArrayExpression' ? (mNode.elements as Ast[]) : [mNode];
  if (nodes.length === 0) return ok({ state: 'invalid', span: mSpan, detail: 'an empty matcher list' });
  const entries = nodes.map((n): MatcherEntry => {
    // The whole config already read as literal syntax, so every entry does.
    const v = (literal(n) as { value: Literal }).value;
    const at = src.bytes(n);
    if (typeof v === 'string') return { span: at, source: v, conditional: false };
    if (v === null || typeof v !== 'object' || Array.isArray(v))
      return { span: at, conditional: false, invalid: 'an entry that is neither a string nor an object' };
    const o = v as Record<string, Literal>;
    const extra = Object.keys(o).find((k) => !ENTRY_KEYS.has(k));
    if (extra) return { span: at, conditional: false, invalid: `entry key "${extra}"` };
    if (typeof o.source !== 'string')
      return { span: at, conditional: false, invalid: 'an entry without a string source' };
    if ('locale' in o && typeof o.locale !== 'boolean')
      return { span: at, source: o.source, conditional: false, invalid: 'a non-boolean locale' };
    return { span: at, source: o.source, conditional: 'has' in o || 'missing' in o };
  });
  return ok({ state: 'static', span, matcher: { span: mSpan, entries } });
}

// ---- next.config ----

/** The project's `next.config`: empty and so without effect, or a form the pack does not read and so unknown. */
export type NextConfigRead =
  | { readonly state: 'empty'; readonly span: ByteRange }
  | { readonly state: 'unsupported'; readonly detail: string; readonly span?: ByteRange };

const isModuleExports = (n: Ast): boolean =>
  n.type === 'MemberExpression' &&
  !n.computed &&
  isAst(n.object) &&
  n.object.type === 'Identifier' &&
  n.object.name === 'module' &&
  isAst(n.property) &&
  n.property.type === 'Identifier' &&
  n.property.name === 'exports';
const isEmptyObject = (n: unknown): boolean =>
  isAst(n) && n.type === 'ObjectExpression' && (n.properties as unknown[]).length === 0;

/**
 * Only a config that is statically the empty object is read: no basePath, i18n, rewrites, pageExtensions or any other
 * option that changes which request reaches which file. Every other config is unsupported, whatever it says.
 */
export async function readNextConfig(file: string, bytes: Uint8Array): Promise<NextConfigRead> {
  const src = SourceText.decode(bytes);
  if (!src) return { state: 'unsupported', detail: 'next.config is not valid UTF-8' };
  const prog = await program(file, src);
  if (!prog) return { state: 'unsupported', detail: 'next.config does not parse' };
  const body = (prog.body as Ast[]).filter(
    (s) => !(s.type === 'ExpressionStatement' && typeof s.directive === 'string'),
  );
  const empties = new Set<string>();
  let exported: Ast | undefined;
  for (const s of body) {
    if (s.type === 'VariableDeclaration' && s.kind === 'const' && (s.declarations as Ast[]).length === 1) {
      const d = (s.declarations as Ast[])[0]!;
      if (isAst(d.id) && d.id.type === 'Identifier' && isEmptyObject(d.init)) {
        empties.add(String(d.id.name));
        continue;
      }
    }
    const value =
      s.type === 'ExportDefaultDeclaration'
        ? s.declaration
        : s.type === 'ExpressionStatement' &&
            isAst(s.expression) &&
            s.expression.type === 'AssignmentExpression' &&
            s.expression.operator === '=' &&
            isAst(s.expression.left) &&
            isModuleExports(s.expression.left)
          ? s.expression.right
          : undefined;
    if (
      value !== undefined &&
      !exported &&
      (isEmptyObject(value) || (isAst(value) && value.type === 'Identifier' && empties.has(String(value.name))))
    ) {
      exported = s;
      continue;
    }
    return {
      state: 'unsupported',
      span: src.bytes(s),
      detail: 'next.config holds a statement other than an empty object export',
    };
  }
  if (!exported) return { state: 'unsupported', detail: 'next.config exports no empty object' };
  return { state: 'empty', span: src.bytes(exported) };
}
