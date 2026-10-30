/** Queries use the same bundled WASM grammars as the adapters; no source-supplied code is loaded. */
import { extname } from 'node:path';
import { loadLanguage, type TSNode } from './harness.js';

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
    options?: { matchLimit?: number; timeoutMicros?: number },
  ): {
    patternIndex: number;
    captures: { name: string; node: TSNode }[];
  }[];
  didExceedMatchLimit(): boolean;
}

const queries = new Map<string, Promise<GrammarQuery>>();

/** Memoised per grammar and query source. The grammar must be one shipped in the bundle. */
export function grammarQuery(grammar: string, source: string): Promise<GrammarQuery> {
  if (!Object.values(GRAMMARS).includes(grammar)) return Promise.reject(new Error('Unsupported grammar'));
  const key = JSON.stringify([grammar, source]);
  let query = queries.get(key);
  if (!query) {
    query = loadLanguage(grammar).then((language) =>
      (language as { query(source: string): GrammarQuery }).query(source),
    );
    queries.set(key, query);
    // A typo should be repairable and failed compilations should not accumulate.
    void query.catch(() => queries.delete(key));
  }
  return query;
}
