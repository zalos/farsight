/**
 * The OpenAPI post-pass over a repo fragment, and a spec as a source of its
 * own. Called from `ingestRepo()` after the language adapters have merged:
 * every discovered/declared document is reconciled against the routes the
 * code adapters found (core/openapi.ts `applySpecToFragment`), which stamps
 * contracts + drift on the route nodes, adds declared-only routes, and adds
 * the `api` node. Freshness meta folds the spec files in.
 */
import { createHash } from 'node:crypto';
import type { GraphFragment } from '@farsight/core';
import { applySpecToFragment, specToFragment, type ReconcileResult } from '@farsight/core';
import { loadWorkspaceConfig, type WorkspaceConfig } from '../shared/config-files.js';
import type { IngestOptions } from '../types.js';
import { discoverSpecs } from './discover.js';
import { readSpecSource, isSpecUrl } from './read.js';

export { parseSpecText, readSpecSource, specToYaml, isSpecUrl } from './read.js';
export { discoverSpecs } from './discover.js';

export interface SpecApplication {
  path: string;
  origin: 'file' | 'config';
  result: ReconcileResult;
}

/** Discover + reconcile every spec for the repo into the fragment (in place). Never throws: unreadable specs are reported in `errors`. */
export async function applySpecs(fragment: GraphFragment, repoRoot: string, options: IngestOptions, workspace?: WorkspaceConfig): Promise<{ applied: SpecApplication[]; errors: string[] }> {
  const config = (workspace ?? loadWorkspaceConfig(repoRoot, options)).merged;
  const { specs, errors } = await discoverSpecs(repoRoot, options, config.openapi ?? []);
  const applied: SpecApplication[] = [];
  if (!specs.length) return { applied, errors };
  const hash = createHash('sha1').update(fragment.meta?.sourceHash ?? '');
  for (const spec of specs) {
    const result = applySpecToFragment(fragment, spec.doc, { repo: fragment.repo, path: spec.path, lineOf: spec.lineOf, ...(spec.name ? { name: spec.name } : {}) });
    applied.push({ path: spec.path, origin: spec.origin, result });
    hash.update(`\n${spec.path}:`).update(spec.text);
  }
  fragment.meta = { files: (fragment.meta?.files ?? 0) + specs.length, sourceHash: hash.digest('hex').slice(0, 12) };
  return { applied, errors };
}

/**
 * A spec as a source with no code: a URL the API serves, or a lone file.
 * Produces the api node and its declared routes (status spec-only — declared,
 * not implemented — until another source implements them and stitchHttp
 * links consumers).
 */
export async function ingestSpec(pathOrUrl: string, options: { repoName?: string; name?: string } = {}): Promise<GraphFragment> {
  const parsed = await readSpecSource(pathOrUrl);
  const repo = options.repoName ?? (isSpecUrl(pathOrUrl) ? new URL(pathOrUrl).hostname : pathOrUrl.split('/').pop()!.replace(/\.(ya?ml|json)$/i, ''));
  const fragment = specToFragment(parsed.doc, { repo, path: pathOrUrl, lineOf: parsed.lineOf, ...(options.name ? { name: options.name } : {}) });
  fragment.meta = { files: 1, sourceHash: createHash('sha1').update(parsed.text).digest('hex').slice(0, 12) };
  return fragment;
}
