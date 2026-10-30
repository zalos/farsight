/**
 * Reusable tree-sitter substrate for language adapters (Java today; C#, Go,
 * Python, Ruby… are one grammar + semantics layer away). Grammars come
 * prebuilt from @vscode/tree-sitter-wasm — pure WASM, runtime and grammars
 * ABI-matched by the VS Code team, no native modules.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** Minimal structural view of a web-tree-sitter syntax node — what adapters actually use. */
export interface TSNode {
  type: string;
  hasError: boolean;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: (TSNode | null)[];
  childForFieldName(name: string): TSNode | null;
  parent: TSNode | null;
}

interface TSParser {
  setLanguage(lang: unknown): void;
  parse(source: string): { rootNode: TSNode; delete(): void } | null;
  delete(): void;
}

let initialized: Promise<void> | undefined;
const languages = new Map<string, Promise<unknown>>();

/** Load a grammar by @vscode/tree-sitter-wasm basename ('java', 'c-sharp'…), memoized. */
export async function loadLanguage(name: string): Promise<unknown> {
  let lang = languages.get(name);
  if (!lang) {
    lang = (async () => {
      // the package's main IS the runtime (wasm/tree-sitter.js); grammars sit next to it
      const runtimePath = require.resolve('@vscode/tree-sitter-wasm');
      const { Parser, Language } = require('@vscode/tree-sitter-wasm');
      initialized ??= Parser.init();
      await initialized;
      return Language.load(join(dirname(runtimePath), `tree-sitter-${name}.wasm`));
    })();
    languages.set(name, lang);
  }
  return lang;
}

/** A parse function for one grammar. Returns null for files the grammar cannot parse at all. */
export async function grammarParser(name: string): Promise<((source: string) => TSNode | null) & { dispose(): void }> {
  const language = await loadLanguage(name);
  const { Parser } = require('@vscode/tree-sitter-wasm');
  const parser: TSParser = new Parser();
  parser.setLanguage(language);
  let tree: ReturnType<TSParser['parse']>;
  const parse = (source: string) => {
    tree?.delete();
    tree = null;
    try {
      tree = parser.parse(source);
      return tree?.rootNode ?? null;
    } catch {
      return null; // unparsable file: the adapter skips it, never fails the ingest
    }
  };
  return Object.assign(parse, {
    dispose() {
      tree?.delete();
      tree = null;
      parser.delete();
    },
  });
}

/**
 * Depth-first walk. Return false from the visitor to skip a subtree
 * (same contract as the oxc walker in walk.ts).
 */
export function walkTS(node: TSNode | null, visit: (n: TSNode) => void | boolean): void {
  if (!node) return;
  if (visit(node) === false) return;
  for (const child of node.namedChildren) {
    if (child) walkTS(child, visit);
  }
}

/** Named children of a given type (direct only). */
export function childrenOfType(node: TSNode, type: string): TSNode[] {
  return node.namedChildren.filter((c): c is TSNode => !!c && c.type === type);
}

/** First descendant of a given type, depth-first. */
export function findFirst(node: TSNode | null, type: string): TSNode | null {
  let hit: TSNode | null = null;
  walkTS(node, (n) => {
    if (hit) return false;
    if (n.type === type) {
      hit = n;
      return false;
    }
  });
  return hit;
}
