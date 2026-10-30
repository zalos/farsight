import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'oxc-parser';
import {
  glossaryEntryFor,
  frameworkAliasNames,
  declaredNodePath,
  DeclaredNodeIndex,
  declaredNodeTarget,
  declaredNodeHandler,
  declaredNodeGuards,
  scopeOfDir,
  t,
} from '@farsight/core';
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
export function declaredPathWarnings(
  fragment: GraphFragment,
  root: string,
  options: IngestOptions,
  ws: WorkspaceConfig,
  manifests: ParsedManifest[] = [],
): string[] {
  const warnings: string[] = [];
  const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
  const strings = (value: string[] | undefined) => list(value).filter((v) => typeof v === 'string');
  const affectsWarnings = (fragment.meta?.decisions?.notes ?? []).filter(
    (note) => note.includes(' affects "') && note.includes('names no node'),
  );
  if (
    !ws.files.some(
      (f) =>
        list(f.config.externals).some((e) => e && typeof e.import === 'string' && e.import.includes('::')) ||
        strings(f.config.plumbing).length ||
        strings(f.config.setup).length ||
        Object.keys(f.config.glossary ?? {}).length ||
        Object.keys(f.config.gateTiers ?? {}).length ||
        Object.keys(f.config.frameworks ?? {}).length ||
        list(f.config.patterns).length ||
        list(f.config.nodes).length,
    ) &&
    !manifests.length
  )
    return affectsWarnings;
  const files = new Set(
    collectFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.java'], options).map((path) =>
      relative(root, path).replaceAll('\\', '/'),
    ),
  );
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
        } catch {
          /* The warning says no indexed symbol, never that malformed code defines none. */
        }
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
  const declaredIndex = new DeclaredNodeIndex(fragment.nodes, fragment.edges);
  for (const file of ws.files) {
    let text = '';
    if (file.from !== 'workspace') {
      try {
        text = readFileSync(join(root, file.path), 'utf8');
      } catch {
        /* Already reported by config loading. */
      }
    }
    const location = (key: string) => (file.from === 'workspace' ? file.path : `${file.path}:${lineOf(text, key)}`);
    const scoped = fragment.nodes.filter(
      (n) => file.root || file.dir === '.' || n.loc?.path.startsWith(`${file.dir}/`),
    );
    const entries = declarationLocations(text);
    const summaries = new Map(
      (ws.meta.files.find((f) => f.path === file.path)?.nodes ?? []).map((n) => [`${n.kind}:${n.name}`, n]),
    );
    for (const [entry, declaration] of (file.config.nodes ?? []).entries()) {
      const notes: string[] = [];
      const note = (field: string, value: string, reason: string) => {
        const range = entries[entry]?.[field];
        const offset = range
          ? range.start + Math.max(0, text.slice(range.start, range.end).indexOf(JSON.stringify(value)))
          : 0;
        const where =
          file.from === 'workspace' ? file.path : `${file.path}:${text.slice(0, offset).split('\n').length}`;
        const message = `${where} → nodes.${field}: ${JSON.stringify(value)} ${reason}`;
        notes.push(message);
        warnings.push(message);
      };
      if (declaration.loc) {
        const loc = declaration.loc.match(/^(.*):([1-9]\d*)$/);
        const path = loc && declaredNodePath(loc[1]!, file.dir);
        if (!path || !files.has(path))
          note('loc', declaration.loc, t(path ? 'config.nodes.missingLoc' : 'config.nodes.outsideLoc', 'professional'));
      }
      const scope = scopeOfDir(file.dir);
      const target = declaredNodeTarget(declaredIndex, declaration, fragment.repo);
      if (target?.loc && scope && !scope(target))
        note('name', declaration.name, t('config.nodes.outsideTarget', 'professional'));
      if (declaration.kind === 'route') {
        if (declaration.handler && !declaredNodeHandler(declaredIndex, declaration.handler, fragment.repo, file.dir))
          note('handler', declaration.handler, t('config.nodes.missingHandler', 'professional'));
        for (const label of declaration.guards ?? [])
          if (!declaredNodeGuards(declaredIndex, label, file.config, fragment.repo, scope).length)
            note('guards', label, t('config.nodes.missingGuard', 'professional'));
      }
      const summary = summaries.get(`${declaration.kind}:${declaration.name}`);
      if (summary && notes.length) summary.notes = [...(summary.notes ?? []), ...notes];
    }
    for (const row of fragment.meta?.patterns?.rules ?? []) {
      if (row.file !== file.path) continue;
      const budgetReasons = ['budget', 'fileBudget', 'byteBudget', 'queryLimit'].map((key) =>
        t('config.patterns.' + key, 'professional'),
      );
      const skips = row.skipped.filter((skip) => row.matched === 0 || budgetReasons.includes(skip.reason));
      if (skips.length) {
        for (const skip of skips) warn(`${location(row.id)} → patterns`, row.id, `${skip.path}: ${skip.reason}`);
      } else if (row.matched === 0)
        warn(`${location(row.id)} → patterns`, row.id, t('config.patterns.unmatched', 'professional'));
    }
    for (const [group, names] of Object.entries(frameworkAliasNames(file.config.frameworks) ?? {})) {
      for (const name of names) {
        const matched =
          group === 'spring.delegates'
            ? fragment.nodes.some(
                (n) =>
                  n.kind === 'class' &&
                  n.tags.some((tag) => tag.startsWith('implements:') && globToRegExp(name).test(tag.slice(11))),
              )
            : fragment.edges.some(
                (e) =>
                  e.resolution?.note?.includes(`frameworks.${group}`) &&
                  e.resolution.note.startsWith(`${group.startsWith('express.') ? '' : '@'}${name} read as`),
              ) ||
              (group === 'spring.mappings' &&
                fragment.meta?.routes?.gaps.some((g) => g.text.startsWith(`@${name} on `)));
        if (!matched)
          warn(`${location(name)} → frameworks.${group}`, name, t('config.alias.unmatched', 'professional'));
      }
    }
    for (const [key, entry] of Object.entries(file.config.glossary ?? {})) {
      const found = scoped.some((n) => {
        const colon = n.kind === 'guard' ? n.name.indexOf(': ') : -1;
        return !!glossaryEntryFor(colon > 0 ? n.name.slice(0, colon) : n.name, { [key]: entry });
      });
      if (!found) warn(`${location(key)} → glossary`, key, 'matches no indexed symbol name.');
    }
    for (const key of Object.keys(file.config.gateTiers ?? {})) {
      const found = scoped.some(
        (n) =>
          (n.kind === 'guard' || n.kind === 'rule') &&
          (n.id === key || `${n.loc?.path ?? ''} ${n.name}`.toLowerCase().includes(key.toLowerCase())),
      );
      if (!found) warn(`${location(key)} → gateTiers`, key, 'matches no indexed gate.');
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
      } else if (
        !symbol ||
        (!classNames(path.replace(/^\.\//, '')).has(symbol) &&
          !fragment.nodes.some((n) => n.kind === 'class' && n.loc?.path === path && n.name === symbol))
      ) {
        warn(where, ref, 'names no indexed class in that file.');
      }
    }
    for (const value of strings(file.config.plumbing)) {
      const path = rebasePath(file.dir, value, `${file.path} → plumbing`, []);
      const pattern = path ? globToRegExp(path) : undefined;
      if (!pattern || ![...files].some((p) => pattern.test(p))) {
        warn(
          `${file.path} → plumbing`,
          value,
          'matches no indexed source file (missing, ignored, excluded or unsupported).',
        );
      }
    }
    for (const value of strings(file.config.setup)) {
      const found = scoped.some(
        (node) =>
          node.id === value ||
          (node.kind === 'function' &&
            `${node.loc?.path ?? ''} ${node.name}`.toLowerCase().includes(value.toLowerCase())),
      );
      if (!found) warn(`${file.path} → setup`, value, 'matches no indexed symbol.');
    }
  }
  for (const manifest of manifests) {
    for (const flow of manifest.manifest.flows ?? []) {
      for (const ref of new Set(flow.docs ?? [])) {
        if (/^https?:\/\//i.test(ref)) continue;
        const path = ref.split('#')[0]!;
        if (!readDocQuote(root, path))
          warn(
            `${manifest.path}:${lineOf(manifest.text, ref)} → flows.${flow.id}.docs`,
            ref,
            'names no readable source document.',
          );
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

/** Source spans for each field of each top-level nodes entry; repeated labels elsewhere cannot steal its line. */
function declarationLocations(text: string): Record<string, { start: number; end: number }>[] {
  if (!text) return [];
  try {
    const parsed = parseSync('config.ts', `(${text})`);
    const program = typeof parsed.program === 'string' ? JSON.parse(parsed.program) : parsed.program;
    const expression = program.body[0]?.expression;
    const object = expression?.expression ?? expression;
    const nodes = object?.properties?.find(
      (p: { key: { name?: string; value?: string } }) => (p.key?.name ?? p.key?.value) === 'nodes',
    );
    return (nodes?.value?.elements ?? []).map(
      (entry: { properties?: { key: { name?: string; value?: string }; value: { start: number; end: number } }[] }) =>
        Object.fromEntries(
          (entry.properties ?? []).map((p) => [
            p.key.name ?? p.key.value,
            { start: p.value.start - 1, end: p.value.end - 1 },
          ]),
        ),
    );
  } catch {
    return [];
  }
}
