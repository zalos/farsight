// Java syntax over captured bytes, for the Spring pack. The grammar is tree-sitter's Java grammar from
// @vscode/tree-sitter-wasm (the version the public parser pins), loaded on first use. It parses only: nothing in a
// project is compiled, resolved or run. Tree-sitter reports offsets in UTF-16 code units; evidence cites UTF-8 bytes,
// so a span is converted exactly, and a file that is not exact UTF-8 gives no span at all.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The structural view of a tree-sitter node this pack reads. */
export interface JavaNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly hasError: boolean;
  readonly namedChildren: readonly (JavaNode | null)[];
  childForFieldName(name: string): JavaNode | null;
  readonly parent: JavaNode | null;
}

interface TreeSitterParser {
  setLanguage(language: unknown): void;
  parse(source: string): { readonly rootNode: JavaNode; delete(): void } | null;
  delete(): void;
}

let loading: Promise<{ Parser: new () => TreeSitterParser; language: unknown }> | undefined;

async function load() {
  loading ??= (async () => {
    const entry = import.meta.resolve('@vscode/tree-sitter-wasm');
    const mod = (await import('@vscode/tree-sitter-wasm')) as unknown as { default?: unknown };
    const api = (mod.default ?? mod) as {
      Parser: { init(): Promise<void> } & (new () => TreeSitterParser);
      Language: { load(path: string): Promise<unknown> };
    };
    await api.Parser.init();
    const language = await api.Language.load(join(dirname(fileURLToPath(entry)), 'tree-sitter-java.wasm'));
    return { Parser: api.Parser, language };
  })();
  return loading;
}

/** One parsed Java file: its tree, its text, and exact byte offsets for spans. */
export class JavaFile {
  readonly path: string;
  readonly content: string;
  readonly text: string;
  readonly root: JavaNode;
  /** Whether the bytes are exact UTF-8, so spans can be cited. */
  readonly exact: boolean;
  private readonly raw: Buffer;
  private readonly dispose: () => void;
  constructor(path: string, content: string, raw: Buffer, text: string, root: JavaNode, dispose: () => void) {
    this.path = path;
    this.content = content;
    this.raw = raw;
    this.text = text;
    this.root = root;
    this.dispose = dispose;
    this.exact = Buffer.byteLength(text, 'utf8') === raw.length && Buffer.from(text, 'utf8').equals(raw);
  }
  /** The UTF-8 byte span of a node, or undefined when the file is not exact UTF-8. */
  span(node: JavaNode): { startByte: number; endByte: number } | undefined {
    if (!this.exact) return undefined;
    return {
      startByte: Buffer.byteLength(this.text.slice(0, node.startIndex), 'utf8'),
      endByte: Buffer.byteLength(this.text.slice(0, node.endIndex), 'utf8'),
    };
  }
  close(): void {
    this.dispose();
  }
}

/** Parses captured bytes. Returns null when the grammar cannot produce a tree. */
export async function parseJava(path: string, content: string, raw: Buffer): Promise<JavaFile | null> {
  const { Parser, language } = await load();
  const parser = new Parser();
  parser.setLanguage(language);
  const text = raw.toString('utf8');
  let tree: ReturnType<TreeSitterParser['parse']>;
  try {
    tree = parser.parse(text);
  } catch {
    tree = null;
  }
  if (!tree) {
    parser.delete();
    return null;
  }
  const t = tree;
  return new JavaFile(path, content, raw, text, t.rootNode, () => {
    t.delete();
    parser.delete();
  });
}

// ---- small syntax helpers ----

export const named = (n: JavaNode | null | undefined): JavaNode[] =>
  n ? n.namedChildren.filter((c): c is JavaNode => c !== null) : [];

export function walk(n: JavaNode, visit: (n: JavaNode) => void): void {
  visit(n);
  for (const c of named(n)) walk(c, visit);
}

/** A string literal's value when it has no escapes or interpolation; otherwise undefined. */
export function literalString(n: JavaNode | null | undefined): string | undefined {
  if (!n || n.type !== 'string_literal') return undefined;
  const parts = named(n);
  if (parts.length === 0) return '';
  if (parts.length !== 1 || parts[0]!.type !== 'string_fragment') return undefined;
  return parts[0]!.text;
}

export interface Annotation {
  readonly name: string;
  readonly node: JavaNode;
  /** The positional value (`@A("x")` or `@A({"x","y"})`), as nodes. */
  readonly positional: readonly JavaNode[];
  readonly pairs: ReadonlyMap<string, JavaNode>;
}

/** The annotations in a declaration's modifiers. */
export function annotationsOf(decl: JavaNode): Annotation[] {
  const mods = named(decl).find((c) => c.type === 'modifiers');
  const out: Annotation[] = [];
  for (const a of named(mods)) {
    if (a.type !== 'marker_annotation' && a.type !== 'annotation') continue;
    const nameNode =
      a.childForFieldName('name') ?? named(a).find((c) => c.type === 'identifier' || c.type === 'scoped_identifier');
    const name = (nameNode?.text ?? '').split('.').pop() ?? '';
    const args = named(a).find((c) => c.type === 'annotation_argument_list');
    const positional: JavaNode[] = [];
    const pairs = new Map<string, JavaNode>();
    for (const arg of named(args)) {
      if (arg.type === 'element_value_pair') {
        const key = arg.childForFieldName('key')?.text ?? named(arg)[0]?.text ?? '';
        const value = arg.childForFieldName('value') ?? named(arg)[1];
        if (value) pairs.set(key, value);
      } else positional.push(arg);
    }
    out.push({ name, node: a, positional, pairs });
  }
  return out;
}

/** Literal strings of an annotation value: one string or an array of strings. Undefined when anything else. */
export function stringValues(n: JavaNode | undefined): string[] | undefined {
  if (!n) return undefined;
  if (n.type === 'string_literal') {
    const v = literalString(n);
    return v === undefined ? undefined : [v];
  }
  if (n.type === 'element_value_array_initializer') {
    const out: string[] = [];
    for (const c of named(n)) {
      const v = literalString(c);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  return undefined;
}

export function modifierWords(decl: JavaNode): Set<string> {
  const mods = named(decl).find((c) => c.type === 'modifiers');
  // Keyword modifiers are anonymous children; read them from the text outside annotations.
  const words = new Set<string>();
  if (!mods) return words;
  let text = mods.text;
  for (const a of named(mods)) text = text.replace(a.text, ' ');
  for (const w of text.split(/\s+/)) if (w) words.add(w);
  return words;
}

/** The method invocations of a fluent chain, innermost first, and the identifier it starts from. */
export function fluentChain(n: JavaNode): { root: JavaNode | null; calls: JavaNode[] } {
  const calls: JavaNode[] = [];
  let cur: JavaNode | null = n;
  while (cur && cur.type === 'method_invocation') {
    calls.unshift(cur);
    cur = cur.childForFieldName('object');
  }
  return { root: cur, calls };
}

export const callName = (call: JavaNode): string => call.childForFieldName('name')?.text ?? '';
export const callArgs = (call: JavaNode): JavaNode[] => named(call.childForFieldName('arguments'));
