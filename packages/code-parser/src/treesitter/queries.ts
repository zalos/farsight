/** Queries use the same bundled WASM grammars as the adapters; no source-supplied code is loaded. */
import { extname } from 'node:path';
import { createRequire } from 'node:module';
import { loadLanguage, type TSNode } from './harness.js';

const require = createRequire(import.meta.url);
export const QUERY_MAX_CHARS = 4096;
export const QUERY_LITERAL_MAX_CHARS = 512;

/** Check before Query compiles its JavaScript predicate regexes. Quoted literals include predicate patterns. */
export function queryLimitProblem(source: string): 'queryLength' | 'predicateLength' | undefined {
  if (source.length > QUERY_MAX_CHARS) return 'queryLength';
  // Ignore comments and count escaped source characters conservatively, before any predicate compiles.
  for (const token of source.matchAll(/;[^\n]*|"(?:\\[\s\S]|[^"\\])*"/g)) {
    if (token[0].startsWith('"') && token[0].length - 2 > QUERY_LITERAL_MAX_CHARS) return 'predicateLength';
  }
  return undefined;
}

const GRAMMARS: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.java': 'java',
  '.cs': 'c-sharp',
  '.go': 'go',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.php': 'php',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.sh': 'bash',
  '.bash': 'bash',
  '.css': 'css',
  '.ini': 'ini',
  '.regex': 'regex',
  '.ps1': 'powershell',
};

export function grammarForFile(path: string): string | undefined {
  return GRAMMARS[extname(path).toLowerCase()];
}

export interface GrammarQuery {
  matches(
    root: TSNode,
    options?: { matchLimit?: number; timeoutMicros?: number; progressCallback?: () => boolean },
  ): {
    patternIndex: number;
    captures: { name: string; node: TSNode }[];
  }[];
  didExceedMatchLimit(): boolean;
}

const queries = new Map<string, Promise<GrammarQuery>>();

/** Memoised per grammar and query source. The grammar must be one shipped in the bundle. */
export function grammarQuery(grammar: string, source: string): Promise<GrammarQuery> {
  const limit = queryLimitProblem(source);
  if (limit) return Promise.reject(Object.assign(new Error(limit), { code: limit }));
  if (!Object.values(GRAMMARS).includes(grammar)) return Promise.reject(new Error('Unsupported grammar'));
  const key = JSON.stringify([grammar, source]);
  let query = queries.get(key);
  if (!query) {
    query = loadLanguage(grammar).then((language) => {
      const { Query } = require('@vscode/tree-sitter-wasm');
      return new Query(language, source) as GrammarQuery;
    });
    queries.set(key, query);
    // A typo should be repairable and failed compilations should not accumulate.
    void query.catch(() => queries.delete(key));
  }
  return query;
}
