import { canonicalJson, graphDocument, GRAPH_SCHEMA_VERSION, type GraphFragment } from '@farsight/graph';
import { collectFiles } from './shared/files.js';
import { RepositoryRead, sha256, readFileSync } from './repository.js';
import { PARSER_VERSION } from './version.js';
import { basename } from 'node:path';
import { parseJsonc } from './aliases.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { AdapterOptions, AnalysisArtifact, LanguageAdapter, ParseRepositoryOptions } from './types.js';

export type { AdapterOptions, LanguageAdapter, ParseRepositoryOptions, ParserLimits, AnalysisArtifact, Diagnostic, FileAnalysis, InputFingerprint } from './types.js';
export { PARSER_VERSION } from './version.js';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Registration is local to each instance. Imports do not load native or WASM adapters. */
export function createParser(options: { adapters: readonly LanguageAdapter[] }) {
  const ids = new Set<string>();
  const adapters = options.adapters.map(adapter => {
    if (!adapter.id || !adapter.version || ids.has(adapter.id) || !adapter.extensions.length) throw new TypeError('Adapters need unique ids, versions and extensions');
    ids.add(adapter.id);
    return Object.freeze({ id: adapter.id, version: adapter.version, extensions: Object.freeze([...adapter.extensions]), ingest: adapter.ingest.bind(adapter) });
  });
  const extractRepository = async (root: string, opts: AdapterOptions = {}): Promise<GraphFragment[]> => {
    const fragments: GraphFragment[] = [];
    for (const adapter of adapters) {
      const fragment = await adapter.ingest(root, opts);
      if ((fragment.meta?.files ?? 0) > 0 || fragment.nodes.length > 0) fragments.push(fragment);
    }
    return fragments;
  };

  const parseRepository = async (request: ParseRepositoryOptions): Promise<AnalysisArtifact> => {
    if (!request.sourceId || request.sourceId.includes('::') || /[\r\n/\\]/.test(request.sourceId)) throw new TypeError('sourceId must be an explicit stable name without separators');
    const scope = new RepositoryRead(request.root, request.signal, request.limits);
    return scope.run(async () => {
      const { root: _root, sourceId, signal: _signal, limits: _limits, inputs, ...selection } = request;
      const opts: AdapterOptions = { ...selection, repoName: sourceId };
      const exts = [...new Set(adapters.flatMap(a => [...a.extensions]))];
      // Pin dependency and resolution declarations even when this run has no bare import.
      // Relative tsconfig extends are additionally captured when the resolver reads them.
      scope.discoveryExtensions = exts;
      const declarations = collectFiles(scope.root, ['.json', '.yaml', '.yml', '.lock'], { exclude: opts.exclude });
      for (const file of declarations) {
        if (!/^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^.]+)*\.json|pnpm-(?:workspace|lock)\.yaml|yarn\.lock)$/.test(basename(file))) continue;
        try {
          const bytes = readFileSync(file);
          if (file.endsWith('.json')) {
            const value = basename(file).startsWith('tsconfig') ? parseJsonc(bytes.toString('utf8')) : JSON.parse(bytes.toString('utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid resolution declaration');
          }
        } catch {
          scope.report({ code: 'read-error', severity: 'error', path: scope.path(file), message: 'Resolution input could not be read as a configuration object.' });
        }
      }
      scope.discoveringSources = true;
      const files = collectFiles(scope.root, exts, opts, name => name.endsWith('.d.ts')).sort();
      for (const file of files) {
        if (scope.selected.size % 100 === 0) await yieldToEventLoop();
        const path = scope.path(file);
        if (scope.selected.size >= scope.limits.maxFiles) {
          scope.files.set(path, { path, status: 'skipped', reason: 'maxFiles' });
          scope.report({ code: 'resource-limit', severity: 'warning', path, message: 'Analysis reached maxFiles.' });
          continue;
        }
        try {
          const body = readFileSync(file);
          scope.selected.add(file);
          scope.files.set(path, { path, status: 'skipped', reason: 'not-analyzed', digest: sha256(body) });
        } catch {
          scope.files.set(path, { path, status: 'failed', reason: 'read-error' });
          scope.report({ code: 'read-error', severity: 'error', path, message: 'Source bytes could not be read.' });
        }
      }
      scope.selectionReady = true;
      const fragments: GraphFragment[] = [];
      for (const adapter of adapters) {
        try {
          scope.checkpoint();
          const fragment = await adapter.ingest(scope.root, opts);
          // Validate each adapter at its boundary before combining untrusted output.
          graphDocument(fragment);
          fragments.push(fragment);
          scope.checkpoint();
        } catch {
          scope.report({ code: 'adapter-error', severity: 'error', adapter: adapter.id, message: 'Adapter did not finish successfully.' });
          for (const [path, file] of scope.files) if (adapter.extensions.some(ext => path.endsWith(ext)) && file.reason === 'not-analyzed') {
            scope.files.set(path, { ...file, status: 'failed', reason: 'adapter-error', adapter: adapter.id });
          }
        }
      }
      const nodes = new Map(fragments.flatMap(f => f.nodes).map(n => [n.id, n]));
      // Stable ids describe relationship content rather than an adapter's sequence counter.
      const edges = fragments.flatMap(f => f.edges).map(e => ({ ...e,
        id: 'edge:' + sha256(canonicalJson({ kind: e.kind, from: e.from, to: e.to, meta: e.meta, resolution: e.resolution })),
      }));
      const unique = new Map<string, typeof edges[number]>();
      for (const edge of edges) {
        const prior = unique.get(edge.id);
        if (prior?.occurrences || edge.occurrences) {
          const sites = new Map([...(prior?.occurrences ?? []), ...(edge.occurrences ?? [])].map(site => [site.id, site]));
          edge.occurrences = [...sites.values()];
        }
        unique.set(edge.id, edge);
      }
      const fileRows = [...scope.files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const packages = fragments.map(fragment => fragment.meta?.packages).find(meta => meta);
      const drivers = fragments.flatMap(fragment => fragment.meta?.stores?.drivers ?? []);
      const graph = graphDocument({ repo: sourceId, nodes: [...nodes.values()], edges: [...unique.values()], meta: {
        files: fileRows.filter(file => file.status === 'analyzed').length,
        ...(packages ? { packages } : {}), ...(drivers.length ? { stores: { drivers } } : {}),
      } }).graph;
      const inputRows = [...scope.inputs.values()].sort((a, b) => `${a.path}:${a.kind}` < `${b.path}:${b.kind}` ? -1 : 1);
      const diagnostics = [...scope.diagnostics].sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : 1);
      const versions = adapters.map(({ id, version }) => ({ id, version }));
      const fingerprint = sha256(canonicalJson({ schemaVersion: GRAPH_SCHEMA_VERSION, sourceId, parser: PARSER_VERSION,
        adapters: versions, options: selection, limits: scope.limits, suppliedInputs: inputs, inputs: inputRows, files: fileRows, diagnostics,
      }));
      return freeze({ format: 'farsight-analysis', schemaVersion: GRAPH_SCHEMA_VERSION, graph, analysis: {
        fingerprint, parser: { name: '@farsight/code-parser', version: PARSER_VERSION }, adapters: versions,
        inputs: inputRows, files: fileRows, diagnostics,
        complete: diagnostics.length === 0 && fileRows.every(f => f.status === 'analyzed' || ['include', 'test-file', 'declaration-file'].includes(f.reason ?? '')),
        capabilities: ['syntax-symbols', 'structural-relationships', 'resolution-evidence', 'call-site-occurrences'],
        limits: ['Syntax and heuristic analysis; no exhaustive execution paths or taint flow.',
          'Cancellation and time limits are checked between synchronous operations; an active native parse is not preempted.',
          'Built-in adapters read local files only, refuse symbolic links, and never execute the repository.',
          'Custom adapters are trusted code and must honor the same read and diagnostic contract.',
          'Occurrence evidence covers supported resolved calls; its absence does not establish that a relationship has no source sites.'],
      } });
    });
  };
  return Object.freeze({ parseRepository, extractRepository });
}
