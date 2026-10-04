/**
 * The design post-pass over a repo fragment, and a manifest as a source of
 * its own (docs/proposals/design-source.md). Runs from `ingestRepo()` AFTER
 * the OpenAPI pass — reconciling screens against operations needs the
 * contracts — and reconciles every discovered/declared manifest against the
 * page/component nodes (core/design.ts `applyDesignToFragment`). Freshness:
 * Figma's `lastModified` when a token is available (fail-soft, 5 s), else
 * the manifest file's own mtime. Images are never fetched here — the server
 * resolves them on demand.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve, basename } from 'node:path';
import type { GraphFragment, DesignManifest, DesignSource, DesignReconcile } from '@farsight/core';
import { applyDesignToFragment, designToFragment, isDesignManifest, figmaFileKey } from '@farsight/core';
import { loadWorkspaceConfig, type WorkspaceConfig } from '../shared/config-files.js';
import { collectFiles } from '../shared/files.js';
import type { IngestOptions } from '../types.js';

const NAME_RE = /^(screens|design|designs|figma-index)\.json$/i;
const MAX_BYTES = 4 * 1024 * 1024;

export interface DesignDeclaration { manifest?: string; path?: string; url?: string; name?: string }

export interface ParsedManifest {
  manifest: DesignManifest;
  text: string;
  /** repo-relative path, or the URL */
  path: string;
  name?: string;
  origin: 'file' | 'config';
  lastModified?: string;
  freshness?: 'figma' | 'manifest';
}

export function isManifestUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Parse manifest text; throws with a readable message when it is not a screens manifest. */
export function parseManifestText(text: string, label = 'manifest'): DesignManifest {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (err) { throw new Error(`${label}: not valid JSON — ${(err as Error).message}`); }
  if (!isDesignManifest(doc)) throw new Error(`${label}: not a design manifest (needs a non-empty "screens" array of { id, route | component, … })`);
  return doc;
}

/**
 * Figma token from the manifest (`"token": "env:FIGMA_TOKEN"`) or the
 * FIGMA_TOKEN environment variable. Never the literal token in the manifest —
 * a checked-in file must not carry a credential.
 */
export function figmaToken(manifest: DesignManifest): string | undefined {
  const ref = manifest.figma?.token;
  if (ref?.startsWith('env:')) return process.env[ref.slice(4)] || undefined;
  return process.env.FIGMA_TOKEN || undefined;
}

/** Figma file `lastModified` (ISO) — undefined when no token, no file, or any failure (fail-soft, 5 s). */
export async function figmaLastModified(manifest: DesignManifest): Promise<string | undefined> {
  const key = figmaFileKey(manifest.figma?.file);
  const token = figmaToken(manifest);
  if (!key || !token) return undefined;
  try {
    const res = await fetch(`https://api.figma.com/v1/files/${key}?depth=1`, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { lastModified?: string };
    return typeof body.lastModified === 'string' ? body.lastModified : undefined;
  } catch {
    return undefined;
  }
}

/** Read a manifest from a repo-relative path or a URL, with freshness. */
export async function readManifestSource(pathOrUrl: string, cwd = process.cwd()): Promise<ParsedManifest> {
  let text: string;
  let mtime: string | undefined;
  if (isManifestUrl(pathOrUrl)) {
    const res = await fetch(pathOrUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${pathOrUrl}: HTTP ${res.status}`);
    text = await res.text();
  } else {
    const abs = resolve(cwd, pathOrUrl);
    text = readFileSync(abs, 'utf8');
    mtime = statSync(abs).mtime.toISOString();
  }
  const manifest = parseManifestText(text, pathOrUrl);
  const figma = await figmaLastModified(manifest);
  return {
    manifest, text, path: pathOrUrl, origin: 'config',
    ...(figma ? { lastModified: figma, freshness: 'figma' as const } : mtime ? { lastModified: mtime, freshness: 'manifest' as const } : {}),
  };
}

/** Discover manifests by name (`screens.json`, `design.json`, `figma-index.json` anywhere under docs/ or design/) plus the config's declarations. */
export async function discoverManifests(repoRoot: string, options: IngestOptions, declared: DesignDeclaration[] = []): Promise<{ manifests: ParsedManifest[]; errors: string[] }> {
  const manifests: ParsedManifest[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const d of declared) {
    const ref = d.url ?? d.manifest ?? d.path;
    if (!ref) continue;
    try {
      const parsed = await readManifestSource(ref, repoRoot);
      const key = isManifestUrl(ref) ? ref : relative(repoRoot, ref.startsWith('/') ? ref : `${repoRoot}/${ref}`).replace(/^\.\//, '');
      seen.add(key);
      manifests.push({ ...parsed, path: key, origin: 'config', ...(d.name ? { name: d.name } : {}) });
    } catch (err) {
      errors.push(`design ${ref}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  const candidates = collectFiles(repoRoot, ['.json'], options, (base) => !NAME_RE.test(base))
    .filter((abs) => /(^|\/)(docs|design|designs)\//.test(relative(repoRoot, abs)));
  for (const abs of [...new Set(candidates)].sort()) {
    const rel = relative(repoRoot, abs);
    if (seen.has(rel)) continue;
    try {
      if (statSync(abs).size > MAX_BYTES) continue;
      const parsed = await readManifestSource(rel, repoRoot);
      seen.add(rel);
      manifests.push({ ...parsed, origin: 'file' });
    } catch (err) {
      // a file named like a manifest that is not one is worth a word, not a failure
      if (NAME_RE.test(basename(abs))) errors.push(`design ${rel}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return { manifests, errors };
}

export interface DesignApplication { path: string; origin: 'file' | 'config'; result: DesignReconcile }

/**
 * Discover + reconcile every manifest for the repo into the fragment (in place). Never throws: unreadable
 * manifests are reported in `errors`. `workspace` is the source's config files as `ingestRepo` read them
 * (read here when absent): every file's `design[]`, rebased to the repo, is declared; a manifest declared
 * and also found by name is read once.
 */
export async function applyDesigns(fragment: GraphFragment, repoRoot: string, options: IngestOptions, workspace?: WorkspaceConfig): Promise<{ applied: DesignApplication[]; errors: string[] }> {
  const ws = workspace ?? loadWorkspaceConfig(repoRoot, options);
  const { manifests, errors } = await discoverManifests(repoRoot, options, (ws.merged.design ?? []) as DesignDeclaration[]);
  const applied: DesignApplication[] = [];
  if (!manifests.length) return { applied, errors };
  const hash = createHash('sha1').update(fragment.meta?.sourceHash ?? '');
  for (const m of manifests) {
    const source: DesignSource = { repo: fragment.repo, path: m.path, ...(m.name ? { name: m.name } : {}), ...(m.lastModified ? { lastModified: m.lastModified, freshness: m.freshness } : {}) };
    const result = applyDesignToFragment(fragment, m.manifest, source);
    applied.push({ path: m.path, origin: m.origin, result });
    hash.update(`\n${m.path}:`).update(m.text);
  }
  titleDocLinks(fragment, repoRoot);
  fragment.meta = { files: (fragment.meta?.files ?? 0) + manifests.length, sourceHash: hash.digest('hex').slice(0, 12) };
  return { applied, errors };
}

/**
 * A repo-relative document link gets the document's own H1 as its title, read
 * once at ingest. A chip saying `ADR 0006 · Low-friction contractor flow` tells
 * a reader whether to open it; `0006-low-friction-contractor-flow.md` does not
 * (R21). A file that cannot be read keeps its path and says nothing more.
 */
function titleDocLinks(fragment: GraphFragment, repoRoot: string): void {
  const titles = new Map<string, string | null>();
  const titleOf = (ref: string): string | null => {
    if (titles.has(ref)) return titles.get(ref)!;
    let title: string | null = null;
    try {
      const text = readFileSync(resolve(repoRoot, ref), 'utf8').slice(0, 4000);
      const m = text.match(/^#\s+(.+?)\s*$/m);
      if (m) title = m[1]!.trim();
    } catch { title = null; }
    titles.set(ref, title);
    return title;
  };
  for (const n of fragment.nodes) {
    for (const l of n.links ?? []) {
      if (l.kind !== 'doc' || !l.ref || l.title) continue;
      const t = titleOf(l.ref);
      if (t) l.title = t;
    }
  }
}

/** A manifest as a source with no code: the design node and its declared screens (every one designed, not built). */
export async function ingestDesign(pathOrUrl: string, options: { repoName?: string; name?: string } = {}): Promise<GraphFragment> {
  const parsed = await readManifestSource(pathOrUrl);
  const repo = options.repoName ?? (isManifestUrl(pathOrUrl) ? new URL(pathOrUrl).hostname : basename(pathOrUrl).replace(/\.json$/i, ''));
  const source: DesignSource = { repo, path: pathOrUrl, ...(options.name ? { name: options.name } : {}), ...(parsed.lastModified ? { lastModified: parsed.lastModified, freshness: parsed.freshness } : {}) };
  const fragment = designToFragment(parsed.manifest, source);
  fragment.meta = { files: 1, sourceHash: createHash('sha1').update(parsed.text).digest('hex').slice(0, 12) };
  return fragment;
}
