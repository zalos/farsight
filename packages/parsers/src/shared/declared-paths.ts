import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'oxc-parser';
import { glossaryEntryFor } from '@farsight/core';
import { readDocQuote } from '../cited-docs.js';
import type { ParsedManifest } from '../design/index.js';
import type { GraphFragment } from '@farsight/core';
import type { IngestOptions } from '../types.js';
import { collectFiles, globToRegExp } from './files.js';
import { rebasePath, type WorkspaceConfig } from './config-files.js';

/**
 * Audit declarations against the selected source and graph. Notes use the existing config
 * metadata and ingest-warning channel, so CLI, MCP and server sync all retain the same evidence.
 * External classes need not have a fetch call (or a graph node) to be valid declarations.
 */
export function declaredPathWarnings(fragment: GraphFragment, root: string, options: IngestOptions, ws: WorkspaceConfig, manifests: ParsedManifest[] = []): string[] {
  const warnings: string[] = [];
  const list = <T,>(value: T[] | undefined): T[] => Array.isArray(value) ? value : [];
  const strings = (value: string[] | undefined) => list(value).filter(v => typeof v === 'string');
  const affectsWarnings = (fragment.meta?.decisions?.notes ?? []).filter(note => note.includes(' affects "') && note.includes('names no node'));
  if (!ws.files.some(f => list(f.config.externals).some(e => e && typeof e.import === 'string' && e.import.includes('::'))
    || strings(f.config.plumbing).length || strings(f.config.setup).length || Object.keys(f.config.glossary ?? {}).length
    || Object.keys(f.config.gateTiers ?? {}).length) && !manifests.length) return affectsWarnings;
  const files = new Set(collectFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.java'], options)
    .map(path => relative(root, path).replaceAll('\\', '/')));
  const classes = new Map<string, Set<string>>();
  const classNames = (path: string): Set<string> => {
    if (!classes.has(path)) {
      const names = new Set<string>();
      // Only selected files are read: a declaration cannot escape the source or bypass excludes.
      if (files.has(path) && /\.[cm]?[jt]sx?$/.test(path)) {
        try {
          const parsed = parseSync(path, readFileSync(join(root, path), 'utf8'));
          const program = typeof parsed.program === 'string' ? JSON.parse(parsed.program) : parsed.program;
          for (const stmt of program.body) {
            const declaration = stmt.declaration ?? stmt;
            if (declaration.type === 'ClassDeclaration' && declaration.id?.name) names.add(declaration.id.name);
          }
        } catch { /* The warning says no indexed symbol, never that malformed code defines none. */ }
      }
      classes.set(path, names);
    }
    return classes.get(path)!;
  };
  const warn = (where: string, value: string, reason: string) =>
    warnings.push(`${where}: ${JSON.stringify(value)} ${reason}`);
  const lineOf = (text: string, value: string) => {
    const at = text.indexOf(JSON.stringify(value));
    return at < 0 ? 1 : text.slice(0, at).split('\n').length;
  };
  for (const file of ws.files) {
    let text = '';
    try { text = readFileSync(join(root, file.path), 'utf8'); } catch { /* Already reported by config loading. */ }
    const scoped = fragment.nodes.filter(n => file.root || n.loc?.path.startsWith(`${file.dir}/`));
    for (const [key, entry] of Object.entries(file.config.glossary ?? {})) {
      const found = scoped.some(n => {
        const colon = n.kind === 'guard' ? n.name.indexOf(': ') : -1;
        return !!glossaryEntryFor(colon > 0 ? n.name.slice(0, colon) : n.name, { [key]: entry });
      });
      if (!found) warn(`${file.path}:${lineOf(text, key)} → glossary`, key, 'matches no indexed symbol name.');
    }
    for (const key of Object.keys(file.config.gateTiers ?? {})) {
      const found = scoped.some(n => (n.kind === 'guard' || n.kind === 'rule') &&
        (n.id === key || `${n.loc?.path ?? ''} ${n.name}`.toLowerCase().includes(key.toLowerCase())));
      if (!found) warn(`${file.path}:${lineOf(text, key)} → gateTiers`, key, 'matches no indexed gate.');
    }
    for (const declaration of list(file.config.externals)) {
      if (!declaration) continue;
      const ref = declaration.import;
      if (typeof ref !== 'string' || !ref.includes('::') || declaration.kind === 'party') continue;
      const [given, symbol] = ref.split('::');
      const path = rebasePath(file.dir, given!, `${file.path} → externals.import`, []);
      const where = `${file.path} → externals.import`;
      if (!path || !files.has(path.replace(/^\.\//, ''))) {
        warn(where, ref, 'names no indexed source file (missing, ignored, excluded or unsupported).');
      } else if (!symbol || !classNames(path.replace(/^\.\//, '')).has(symbol) && !fragment.nodes.some(n =>
        n.kind === 'class' && n.loc?.path === path && n.name === symbol)) {
        warn(where, ref, 'names no indexed class in that file.');
      }
    }
    for (const value of strings(file.config.plumbing)) {
      const path = rebasePath(file.dir, value, `${file.path} → plumbing`, []);
      const pattern = path ? globToRegExp(path) : undefined;
      if (!pattern || ![...files].some(p => pattern.test(p))) {
        warn(`${file.path} → plumbing`, value, 'matches no indexed source file (missing, ignored, excluded or unsupported).');
      }
    }
    for (const value of strings(file.config.setup)) {
      const found = fragment.nodes.some(node =>
        (file.root || node.loc?.path.startsWith(`${file.dir}/`)) &&
        (node.id === value || node.kind === 'function' && `${node.loc?.path ?? ''} ${node.name}`.toLowerCase().includes(value.toLowerCase())));
      if (!found) warn(`${file.path} → setup`, value, 'matches no indexed symbol.');
    }
  }
  for (const manifest of manifests) {
    for (const flow of manifest.manifest.flows ?? []) {
      for (const ref of new Set(flow.docs ?? [])) {
        if (/^https?:\/\//i.test(ref)) continue;
        const path = ref.split('#')[0]!;
        if (!readDocQuote(root, path)) warn(`${manifest.path}:${lineOf(manifest.text, ref)} → flows.${flow.id}.docs`, ref,
          'names no readable source document.');
      }
    }
  }
  ws.meta.notes.push(...warnings);
  // decisionsMetaOf already resolves effective affects declarations (including config overrides),
  // and keeps unresolved targets in metadata. Also surface them during ingest instead of silently
  // leaving them behind the decisions tool.
  warnings.push(...affectsWarnings);
  return warnings;
}
