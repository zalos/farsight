import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import type { GraphFragment, GraphEdge } from '@farsight/core';
import { applySetupOrigin, applyTooling, DEFAULT_TOOLING } from '@farsight/core';
import type { LanguageAdapter, IngestOptions } from './types.js';
import { collectFiles, contentDigest } from './shared/files.js';
import { tsJsAdapter } from './tsjs.js';
import { javaAdapter } from './java/index.js';
import { applySpecs } from './openapi/index.js';
import { applyDesigns } from './design/index.js';
import { applyTests, testGlobsOf } from './tests/index.js';
import { applyStories } from './stories/index.js';
import { applyStores } from './stores.js';
import { applyProjects, projectOfPath } from './shared/projects.js';
import { loadWorkspaceConfig, applyWorkspaceConfig, applyWorkspaceRouteGuards } from './shared/config-files.js';

export type { LanguageAdapter, IngestOptions } from './types.js';
export { tsJsAdapter, ingestTsJs, SQL_DRIVERS, storeLike } from './tsjs.js';
export { applyStores, prismaProviders, springDatasourceJdbc } from './stores.js';
export { applyProjects, discoverProjects, projectOfPath, projectImports, importSpecifiers, workspaceGlobs } from './shared/projects.js';
export { readNxProjectGraph, NX_GRAPH_PATHS, NX_GRAPH_MAX_BYTES } from './shared/nx-graph.js';
export { loadWorkspaceConfig, emptyWorkspaceConfig, applyWorkspaceConfig, applyWorkspaceRouteGuards, journeysConfigFor, rebasePath, CONFIG_FILE } from './shared/config-files.js';
export type { ConfigFile, WorkspaceConfig } from './shared/config-files.js';
export { javaAdapter, ingestJava } from './java/index.js';
export { applySpecs, ingestSpec, parseSpecText, readSpecSource, specToYaml, isSpecUrl, discoverSpecs } from './openapi/index.js';
export type { SpecApplication } from './openapi/index.js';
export { contentDigest } from './shared/files.js';
export { gitLog, gitTags, gitShallow, gitHeadRef, gitHead, gitHeadAt, gitPrefix, gitShowPatch, gitKnows, gitUnreachable, commitInputsOf, GIT_STATUS_WORD, normalizeRepoPath, DEFAULT_MAX_COMMITS, GIT_ABSENT_WORD, headTitle, shallowFloorSentence } from './shared/git.js';
export type {
  GitCommit, GitFileChange, GitFileStatus, GitTag, GitTagScheme, GitLogOptions, GitLogResult,
  GitHeadResult, GitFact, GitAbsent, GitAbsentReason,
} from './shared/git.js';
export { applyDesigns, ingestDesign, readManifestSource, parseManifestText, discoverManifests, isManifestUrl, figmaToken, figmaLastModified } from './design/index.js';
export type { DesignApplication, ParsedManifest } from './design/index.js';
export {
  applyTests, importReports, isTestFile, DEFAULT_TEST_GLOBS, extractCases, runnerOf, levelOf, classifyCall, fileHeaderDoc,
  CoverTargets, routeKey, fileSignals, findReports, readReport, freshnessOf, changedByOf, testsConfigOf, testGlobsOf,
  eachTitleToRegExp, eachTitleMatches, foldRuns,
} from './tests/index.js';
export type { TestCase, ExtractedFile, TestGlobs, ReadReport, ObservedCase, CoverageHit } from './tests/index.js';
export { applyStories, parseStoryFile, isStoryFile, findStorybookDirs, storiesGlobsOf, globBase } from './stories/index.js';
export type { ParsedStoryFile } from './stories/index.js';

/** Adding a language = one adapter directory + one entry here. */
export const adapters: LanguageAdapter[] = [tsJsAdapter, javaAdapter];

/**
 * The one ingest entry point every consumer (CLI, server /api/sync, MCP
 * refresh_graph) uses: runs each registered adapter over the repo, merges
 * their fragments into a single GraphFragment, then applies the repo's
 * OpenAPI/Swagger documents as a post-pass (contracts + drift on the routes
 * the adapters found — docs augment, never replace). Adapters that find no
 * files contribute nothing. Spec read errors are reported on the fragment's
 * `specErrors`, never thrown.
 *
 * Every `farsight.config.json` of the source is read once here
 * (`loadWorkspaceConfig`: the root file and any nested one, each scoped to its
 * folder) and handed to every pass. Tag rules, glossary, declared function
 * guards/entrypoints go on BEFORE the spec pass (so drift sees config-declared
 * gates), route-shaped guard matchers again AFTER it (for the routes the spec
 * added). Consumers never call applyConfig themselves; `configApplied` says
 * whether a config was found, and `meta.config` lists the files. The setup
 * closure (`applySetupOrigin`) runs straight after it, once the `setup` tags
 * from the config and from the adapters' heuristic are both on the nodes.
 */
export async function ingestRepo(repoPath: string, options: IngestOptions = {}): Promise<GraphFragment> {
  const repoRoot = resolvePath(repoPath);
  const repo = options.repoName ?? repoRoot.split('/').filter(Boolean).pop()!;
  // the source's config files are read once here: their `tests` globs must reach the language
  // adapters (they skip claimed spec files) before any of them runs. `merged` is the root's
  // config with every nested file's paths rebased and its lists unioned (shared/config-files.ts)
  const workspace = loadWorkspaceConfig(repoRoot, options);
  const config = workspace.merged;
  // the config's externals/plumbing/setup blocks travel into the adapters the way testGlobs does
  const merge = <T,>(a?: T[], b?: T[]): T[] | undefined => (a?.length || b?.length ? [...(a ?? []), ...(b ?? [])] : undefined);
  const opts: IngestOptions = {
    ...options,
    repoName: repo,
    testGlobs: { ...testGlobsOf(config?.tests), ...options.testGlobs },
    externals: merge(config?.externals, options.externals),
    plumbing: merge(config?.plumbing, options.plumbing),
    setup: merge(config?.setup, options.setup),
  };
  const fragments: GraphFragment[] = [];
  for (const adapter of adapters) {
    const fragment = await adapter.ingest(repoRoot, opts);
    if ((fragment.meta?.files ?? 0) > 0 || fragment.nodes.length > 0) fragments.push(fragment);
  }
  // the SQL drivers the adapters saw — read now, because the spec and design passes rebuild meta
  const drivers = fragments.flatMap((f) => f.meta?.stores?.drivers ?? []);
  // what the import pass set aside (builtins, alias misses) — read now for the same reason
  const packagesMeta = fragments.map((f) => f.meta?.packages).find((p) => p);
  const merged = mergeFragments(repo, fragments);
  // each file over its own folder: the root first, then the nested ones by depth, so the nearer word wins
  if (applyWorkspaceConfig(merged.nodes, merged.edges, workspace)) merged.configApplied = true;
  // tooling (scripts a person runs) is tagged with or without a config file: the default is `scripts/**` (root-only)
  applyTooling(merged.nodes, merged.edges, config.tooling ?? DEFAULT_TOOLING);
  // after the tags exist (config's `setup` block and the adapters' own heuristic), before anything reads the graph
  applySetupOrigin(merged.nodes, merged.edges);
  if (options.openapi !== false) {
    const { errors } = await applySpecs(merged, repoRoot, opts, workspace);
    if (errors.length) merged.specErrors = errors;
    applyWorkspaceRouteGuards(merged.nodes, merged.edges, workspace);
  }
  // design manifests after the specs: reconciling a screen's operations needs the contracts on the routes
  if (options.design !== false) {
    const { errors } = await applyDesigns(merged, repoRoot, opts, workspace);
    if (errors.length) merged.specErrors = [...(merged.specErrors ?? []), ...errors];
  }
  // which data store each table lives in: code rules first, the config's `stores` last (stores.ts)
  const storesMeta = applyStores(merged, repoRoot, opts, config.stores, drivers);
  // the content digest goes on after the spec and design passes (both rebuild meta from
  // scratch — openapi/index.ts:38, design/index.ts:144) and before the tests pass, whose
  // freshnessOf() compares a report's recorded digest against it
  const digest = repoContentDigest(repoRoot, opts);
  if (merged.meta) merged.meta.sourceDigest = digest;
  else merged.meta = { files: 0, sourceHash: 'empty', sourceDigest: digest };
  if (Object.keys(storesMeta).length) merged.meta.stores = storesMeta;
  else delete merged.meta.stores;
  if (packagesMeta) merged.meta.packages = packagesMeta;
  // which config files the source holds, what each gave, and what two of them disagreed on (§5.3)
  if (workspace.meta.files.length || workspace.meta.notes.length) merged.meta.config = workspace.meta;
  // tests last: `@covers SCR-07` resolves against design screens and `@covers POST /x`
  // against routes a spec may have added, so both passes must have run first
  if (options.tests !== false) {
    const { errors } = applyTests(merged, repoRoot, opts, workspace);
    if (errors.length) merged.specErrors = [...(merged.specErrors ?? []), ...errors];
  }
  // stories: story files are code — each story goes onto the component it renders (ADR 9)
  if (options.stories !== false) {
    const { errors } = applyStories(merged, repoRoot, opts, workspace);
    if (errors.length) merged.specErrors = [...(merged.specErrors ?? []), ...errors];
  }
  // projects last: every node is on the fragment by now (the tests and stories passes add theirs),
  // and each one under a project root carries its project and tags (shared/projects.ts)
  if (options.projects !== false) merged.meta!.projects = applyProjects(merged, repoRoot, opts, config.projects);
  // a workspace package resolves to a directory: name the project that directory belongs to
  // (NX or workspaces), so `@acme/money` reads as the `money` lib rather than as its alias
  const projects = merged.meta?.projects;
  if (projects && projects.tool !== 'none') {
    for (const n of merged.nodes) {
      if (n.kind !== 'package' || n.package?.scope !== 'workspace' || !n.package.root) continue;
      const p = projectOfPath(n.package.root, projects.projects);
      if (p && p.root !== '.') n.package.project = p.name;
    }
  }
  return merged;
}

/**
 * The content digest of a repo's checkout, over the union of every adapter's file set
 * and the same excludes ingest applies — the one place that rule lives, so `ingestRepo`
 * and any consumer that has to reproduce a stamp (CI, `tests import --stamp`) agree.
 */
export function repoContentDigest(repoPath: string, options: IngestOptions = {}): string {
  const root = resolvePath(repoPath);
  const exts = [...new Set(adapters.flatMap((a) => a.extensions))];
  return contentDigest(root, collectFiles(root, exts, options, (name) => name.endsWith('.d.ts')));
}

/**
 * Nodes deduped by id (first adapter wins), edge ids renumbered so adapters
 * can't collide, meta.files summed. A single fragment passes through untouched
 * — single-language repos keep byte-identical output (and sourceHash).
 */
export function mergeFragments(repo: string, fragments: GraphFragment[]): GraphFragment {
  if (fragments.length === 1) return fragments[0]!;
  if (fragments.length === 0) return { repo, nodes: [], edges: [], meta: { files: 0, sourceHash: 'empty' } };
  const seen = new Set<string>();
  const nodes = fragments.flatMap((f) => f.nodes).filter((n) => !seen.has(n.id) && seen.add(n.id));
  let edgeSeq = 0;
  const edges: GraphEdge[] = fragments.flatMap((f) => f.edges).map((e) => ({ ...e, id: `e${edgeSeq++}` }));
  const hash = createHash('sha1');
  let files = 0;
  for (const f of fragments) {
    files += f.meta?.files ?? 0;
    hash.update(`${f.meta?.sourceHash ?? ''}\n`);
  }
  return { repo, nodes, edges, meta: { files, sourceHash: hash.digest('hex').slice(0, 12) } };
}
