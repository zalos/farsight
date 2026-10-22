// Reading Nest registrations from captured TypeScript bytes: a bounded syntax pass with the same pinned oxc-parser the
// public parser uses (0.138.0). It records what the source declares, with exact UTF-8 byte spans; it decides nothing.
// Only literal, statically resolvable forms are understood; every other form is returned as a frontier with its span.
// Nothing here executes, imports or evaluates target code.
type ParseSync = (path: string, text: string, options: object) => { program: unknown; errors?: unknown[] };
let parseSync: ParseSync | null = null;

/** Loads the parser on first use: its native binding is never loaded by importing this module. */
export async function loadParser(): Promise<void> {
  if (!parseSync) parseSync = ((await import('oxc-parser')) as { parseSync: ParseSync }).parseSync;
}

export type AstNode = { type: string; start: number; end: number; [k: string]: any };

const isNode = (v: unknown): v is AstNode => typeof v === 'object' && v !== null && typeof (v as AstNode).type === 'string';

export function walk(node: unknown, visit: (n: AstNode) => boolean | void): void {
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return; }
  if (!isNode(node)) return;
  if (visit(node) === false) return;
  for (const [k, v] of Object.entries(node)) if (k !== 'start' && k !== 'end' && k !== 'type' && typeof v === 'object' && v !== null) walk(v, visit);
}

/** A span of the captured bytes: zero-based, half-open UTF-8 offsets, checked against the text. */
export interface Span { readonly startByte: number; readonly endByte: number }

/** One parsed file: its text, a UTF-16 → UTF-8 offset map, its imports and the AST. */
export interface ParsedFile {
  readonly path: string;
  readonly text: string;
  readonly program: AstNode;
  /** local name → module specifier and the name it imports (`*` for a namespace, `default` for a default import) */
  readonly imports: ReadonlyMap<string, { module: string; imported: string }>;
  span(node: { start: number; end: number }): Span | null;
}

export class SyntaxFailure extends Error {
  constructor(readonly reason: 'invalidUtf8' | 'parseError') { super(reason); }
}

/** Parses one captured file. Refuses bytes that are not valid UTF-8 and files with syntax errors. */
export function parseFile(path: string, bytes: Uint8Array): ParsedFile {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new SyntaxFailure('invalidUtf8'); }
  if (!parseSync) throw new Error('loadParser() must complete before parseFile()');
  const result = parseSync(path, text, { sourceType: 'module', lang: path.endsWith('x') ? 'tsx' : 'ts' });
  if ((result as any).errors?.length) throw new SyntaxFailure('parseError');
  const program = (typeof result.program === 'string' ? JSON.parse(result.program) : result.program) as AstNode;
  const imports = new Map<string, { module: string; imported: string }>();
  for (const s of program.body ?? []) {
    if (s.type !== 'ImportDeclaration' || s.importKind === 'type') continue;
    const module = String(s.source?.value ?? '');
    for (const sp of s.specifiers ?? []) {
      if (sp.importKind === 'type') continue;
      const local = String(sp.local?.name ?? '');
      if (sp.type === 'ImportSpecifier') imports.set(local, { module, imported: String(sp.imported?.name ?? sp.imported?.value ?? '') });
      else if (sp.type === 'ImportNamespaceSpecifier') imports.set(local, { module, imported: '*' });
      else if (sp.type === 'ImportDefaultSpecifier') imports.set(local, { module, imported: 'default' });
    }
  }
  // UTF-16 code-unit offset → UTF-8 byte offset, refusing an offset inside a surrogate pair.
  const byteAt = (offset: number): number | null => {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return null;
    const c = text.charCodeAt(offset - 1);
    if (offset > 0 && offset < text.length && c >= 0xd800 && c <= 0xdbff) return null;
    return Buffer.byteLength(text.slice(0, offset), 'utf8');
  };
  return Object.freeze({
    path, text, program, imports,
    span: (n: { start: number; end: number }) => {
      const s = byteAt(n.start), e = byteAt(n.end);
      return s === null || e === null || e < s ? null : { startByte: s, endByte: e };
    },
  });
}

/** The name an expression's callee or reference resolves to: `[local, member?]` for `X` or `ns.X`. */
export function refName(n: AstNode | undefined): { local: string; member?: string } | null {
  if (!n) return null;
  if (n.type === 'Identifier') return { local: String(n.name) };
  if ((n.type === 'MemberExpression' || n.type === 'StaticMemberExpression') && !n.computed && n.object?.type === 'Identifier' && n.property) {
    return { local: String(n.object.name), member: String(n.property.name) };
  }
  return null;
}

/** What a local reference means: imported from a module (with the exported name), or declared in this file. */
export function resolveRef(file: ParsedFile, ref: { local: string; member?: string }): { module: string | null; name: string } {
  const imp = file.imports.get(ref.local);
  if (imp) return imp.imported === '*' ? { module: imp.module, name: ref.member ?? '*' } : { module: imp.module, name: ref.member ? `${imp.imported}.${ref.member}` : imp.imported };
  return { module: null, name: ref.member ? `${ref.local}.${ref.member}` : ref.local };
}

/** The decorator's callee and arguments: `@X(args)` or `@X`. */
export function decoratorCall(d: AstNode): { callee: AstNode; args: AstNode[] } {
  const e = d.expression;
  if (e?.type === 'CallExpression') return { callee: e.callee, args: e.arguments ?? [] };
  return { callee: e, args: [] };
}

export function classesOf(file: ParsedFile): AstNode[] {
  const out: AstNode[] = [];
  for (const s of file.program.body ?? []) {
    const c = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
    if (c?.type === 'ClassDeclaration') out.push(c);
  }
  return out;
}
