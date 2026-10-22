// JavaScript and TypeScript syntax over captured bytes, for the Express pack. The parser is Oxc (the version the
// public parser pins); it only parses, nothing is evaluated. Offsets Oxc reports are UTF-16 code units, converted
// exactly to UTF-8 byte spans of the captured file; a file that is not exact UTF-8 cannot be cited. Oxc has a native
// binding, so it is loaded by the first analysis (`loadParser`), never when the pack is imported.
import type { parseSync as ParseSync } from 'oxc-parser';

let parseSync: typeof ParseSync | undefined;
/** Loads Oxc once; every parse in this module needs it. */
export async function loadParser(): Promise<typeof ParseSync> {
  parseSync ??= (await import('oxc-parser')).parseSync;
  return parseSync;
}
const parser = (): typeof ParseSync => {
  if (!parseSync) throw new Error('loadParser() must complete before parsing');
  return parseSync;
};

/** The ESTree view of an Oxc node this pack reads. */
export interface JsNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export interface JsFile {
  readonly path: string;
  readonly content: string;
  readonly text: string;
  /** The captured bytes are exact UTF-8, so spans can be computed. */
  readonly exact: boolean;
  readonly program: JsNode;
  readonly hasErrors: boolean;
  /** The UTF-8 byte span of a node, or undefined when the file is not exact UTF-8. */
  span(node: JsNode): { startByte: number; endByte: number } | undefined;
}

export const JS_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;
export const isJsPath = (p: string) => JS_EXTENSIONS.some(e => p.endsWith(e)) && !/\.d\.[cm]?ts$/.test(p);

export function parseJs(path: string, content: string, raw: Buffer): JsFile {
  const text = raw.toString('utf8');
  const exact = Buffer.from(text, 'utf8').equals(raw);
  const result = parser()(path, text);
  const program = (typeof result.program === 'string' ? JSON.parse(result.program) : result.program) as JsNode;
  // UTF-16 offset → UTF-8 byte offset, computed once per file.
  let table: Uint32Array | undefined;
  const byteAt = (offset: number) => {
    if (!table) {
      table = new Uint32Array(text.length + 1);
      let b = 0;
      for (let i = 0; i < text.length; i++) {
        table[i] = b;
        const c = text.charCodeAt(i);
        if (c < 0x80) b += 1;
        else if (c < 0x800) b += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { table[i + 1] = b; b += 4; i++; continue; }
        else b += 3;
      }
      table[text.length] = b;
    }
    return table[offset]!;
  };
  return {
    path, content, text, exact, program, hasErrors: result.errors.length > 0,
    span(node) {
      if (!exact || node.start < 0 || node.end > text.length || node.start >= node.end) return undefined;
      return { startByte: byteAt(node.start), endByte: byteAt(node.end) };
    },
  };
}

export const isNode = (v: unknown): v is JsNode => typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';

/** The node's direct children, in source order. */
export function children(node: JsNode): JsNode[] {
  const out: JsNode[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'parent') continue;
    if (Array.isArray(v)) { for (const x of v) if (isNode(x)) out.push(x); }
    else if (isNode(v)) out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Visits every node below `node` (pre-order); returning false skips a node's children. */
export function walk(node: JsNode, visit: (n: JsNode, parents: readonly JsNode[]) => boolean | void, parents: JsNode[] = []): void {
  if (visit(node, parents) === false) return;
  parents.push(node);
  for (const c of children(node)) walk(c, visit, parents);
  parents.pop();
}

/** Removes TypeScript-only wrappers and parentheses that do not change the value. */
export function unwrap(node: JsNode | undefined | null): JsNode | undefined {
  let n = node ?? undefined;
  while (n && ['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression'].includes(n.type)) {
    n = n.expression as JsNode;
  }
  return n;
}

/** A string literal or a template literal without substitutions. */
export function stringValue(node: JsNode | undefined): string | undefined {
  const n = unwrap(node);
  if (!n) return undefined;
  if ((n.type === 'Literal' || n.type === 'StringLiteral') && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && (n.expressions as unknown[]).length === 0) {
    const q = (n.quasis as JsNode[])[0];
    const cooked = (q?.value as { cooked?: string } | undefined)?.cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

/** Parses `text` as a program; for the manifest reader, which wraps JSON as an expression. */
export function parseProgram(path: string, text: string): { program: JsNode; errors: number } {
  const result = parser()(path, text);
  return { program: (typeof result.program === 'string' ? JSON.parse(result.program) : result.program) as JsNode, errors: result.errors.length };
}

export function numberValue(node: JsNode | undefined): number | undefined {
  const n = unwrap(node);
  return n && (n.type === 'Literal' || n.type === 'NumericLiteral') && typeof n.value === 'number' ? n.value : undefined;
}

export const identifierName = (node: JsNode | undefined): string | undefined => {
  const n = unwrap(node);
  return n?.type === 'Identifier' ? n.name as string : undefined;
};

/** `a.b.c` as ['a', 'b', 'c'] for non-computed member chains rooted at an identifier; otherwise undefined. */
export function memberPath(node: JsNode | undefined): string[] | undefined {
  const n = unwrap(node);
  if (!n) return undefined;
  if (n.type === 'Identifier') return [n.name as string];
  if (n.type === 'MemberExpression' && !n.computed) {
    const head = memberPath(n.object as JsNode);
    const prop = (n.property as JsNode).type === 'Identifier' ? (n.property as JsNode).name as string : undefined;
    return head && prop ? [...head, prop] : undefined;
  }
  if (n.type === 'ChainExpression') return memberPath(n.expression as JsNode);
  return undefined;
}

export const isFunction = (n: JsNode | undefined): boolean =>
  !!n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');
