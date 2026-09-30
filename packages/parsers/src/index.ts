import { createHash } from 'node:crypto';
import { resolve as resolvePath, join } from 'node:path';
import type { GraphFragment, GraphEdge } from '@farsight/core';
import { loadConfig, applyConfig, applyRouteGuards, applySetupOrigin, applyTooling, DEFAULT_TOOLING } from '@farsight/core';
import type { LanguageAdapter, IngestOptions } from './types.js';
import { collectFiles, contentDigest } from './shared/files.js';
import { tsJsAdapter } from './tsjs.js';
import { javaAdapter } from './java/index.js';
import { applySpecs } from './openapi/index.js';
import { applyDesigns } from './design/index.js';
import { applyTests, testGlobsOf } from './tests/index.js';
import { applyStories } from './stories/index.js';

export type { LanguageAdapter, IngestOptions } from './types.js';
export { tsJsAdapter, ingestTsJs } from './tsjs.js';
export { javaAdapter, ingestJava } from './java/index.js';
export { applySpecs, ingestSpec, parseSpecText, readSpecSource, specToYaml, isSpecUrl, discoverSpecs } from './openapi/index.js';
export type { SpecApplication } from './openapi/index.js';
export { contentDigest } from './shared/files.js';
export { gitLog, gitTags, gitShallow, gitHeadRef, gitHead, gitHeadAt, gitPrefix, gitShowPatch, gitKnows, commitInputsOf, GIT_STATUS_WORD, normalizeRepoPath, DEFAULT_MAX_COMMITS, GIT_ABSENT_WORD, headTitle, shallowFloorSentence } from './shared/git.js';
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
 * `farsight.config.json` at the repo root is applied here too — tag rules,
 * glossary, declared function guards/entrypoints BEFORE the spec pass (so
 * drift sees config-declared gates), route-shaped guard matchers again AFTER
 * it (for the routes the spec added). Consumers no longer call applyConfig
 * themselves; `configApplied` says whether a config was found. The setup
 * closure (`applySetupOrigin`) runs straight after it, once the `setup` tags
 * from the config and from the adapters' heuristic are both on the nodes.
 */
export async function ingestRepo(repoPath: string, options: IngestOptions = {}): Promise<GraphFragment> {
  const repoRoot = resolvePath(repoPath);
  const repo = options.repoName ?? repoRoot.split('/').filter(Boolean).pop()!;
  // the repo's config is read once here: its `tests` globs must reach the language
  // adapters (they skip claimed spec files) before any of them runs
  const config = options.config === false ? null : loadConfig(join(repoRoot, 'farsight.config.json'));
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
  const merged = mergeFragments(repo, fragments);
  if (config) { applyConfig(merged.nodes, config, merged.edges); merged.configApplied = true; }
  // tooling (scripts a person runs) is tagged with or without a config file: the default is `scripts/**`
  applyTooling(merged.nodes, merged.edges, config?.tooling ?? DEFAULT_TOOLING);
  // after the tags exist (config's `setup` block and the adapters' own heuristic), before anything reads the graph
  applySetupOrigin(merged.nodes, merged.edges);
  if (options.openapi !== false) {
    const { errors } = await applySpecs(merged, repoRoot, opts);
    if (errors.length) merged.specErrors = errors;
    if (config) applyRouteGuards(merged.nodes, config, merged.edges);
  }
  // design manifests after the specs: reconciling a screen's operations needs the contracts on the routes
  if (options.design !== false) {
    const { errors } = await applyDesigns(merged, repoRoot, opts);
    if (errors.length) merged.specErrors = [...(merged.specErrors ?? []), ...errors];
  }
  // the content digest goes on after the spec and design passes (both rebuild meta from
  // scratch — openapi/index.ts:38, design/index.ts:144) and before the tests pass, whose
  // freshnessOf() compares a report's recorded digest against it
  const digest = repoContentDigest(repoRoot, opts);
  if (merged.meta) merged.meta.sourceDigest = digest;
  else merged.meta = { files: 0, sourceHash: 'empty', sourceDigest: digest };
  // tests last: `@covers SCR-07` resolves against design screens and `@covers POST /x`
  // against routes a spec may have added, so both passes must have run first
  if (options.tests !== false) {
    const { errors } = applyTests(merged, repoRoot, opts);
    if (errors.length) merged.specErrors = [...(merged.specErrors ?? []), ...errors];
  }
  // stories: story files are code — each story goes onto the component it renders (ADR 9)
  if (options.stories !== false) {
    const { errors } = applyStories(merged, repoRoot, opts);
    if (errors.length) merged.specErrors = [...(merged.specErrors ?? []), ...errors];
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
