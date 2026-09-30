/**
 * Find the OpenAPI/Swagger documents that describe a repo: by filename
 * (`openapi.*`, `swagger.*`, `api*.yaml`, anything under an `openapi/` dir)
 * then by content (must parse as a spec), plus whatever
 * `farsight.config.json → openapi` declares (paths or URLs — the config is
 * how "the API itself" gets registered as a source of truth for its shape).
 */
import { readFileSync, statSync } from 'node:fs';
import { relative, basename } from 'node:path';
import { collectFiles } from '../shared/files.js';
import type { IngestOptions } from '../types.js';
import { parseSpecText, readSpecSource, isSpecUrl, type ParsedSpec } from './read.js';

const NAME_RE = /^(openapi|swagger|api(-|_)?(spec|docs?)?|.*\.openapi|.*\.swagger)\.(ya?ml|json)$/i;
const MAX_BYTES = 8 * 1024 * 1024;

export interface DiscoveredSpec extends ParsedSpec {
  /** repo-relative path, or the URL */
  path: string;
  text: string;
  name?: string;
  /** 'file' = found by name; 'config' = declared */
  origin: 'file' | 'config';
}

export interface OpenApiDeclaration { path?: string; url?: string; name?: string }

export async function discoverSpecs(repoRoot: string, options: IngestOptions, declared: OpenApiDeclaration[] = []): Promise<{ specs: DiscoveredSpec[]; errors: string[] }> {
  const specs: DiscoveredSpec[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  // declared first — they win over discovery for the same path
  for (const d of declared) {
    const ref = d.url ?? d.path;
    if (!ref) continue;
    try {
      const parsed = await readSpecSource(ref, repoRoot);
      const key = isSpecUrl(ref) ? ref : relative(repoRoot, ref.startsWith('/') ? ref : `${repoRoot}/${ref}`).replace(/^\.\//, '');
      seen.add(key);
      specs.push({ ...parsed, path: key, origin: 'config', ...(d.name ? { name: d.name } : {}) });
    } catch (err) {
      errors.push(`openapi ${ref}: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  const candidates = collectFiles(repoRoot, ['.yaml', '.yml', '.json'], options, (base) => !NAME_RE.test(base))
    .concat(collectFiles(repoRoot, ['.yaml', '.yml', '.json'], options).filter((abs) => /(^|\/)openapi\//.test(relative(repoRoot, abs))));
  for (const abs of [...new Set(candidates)].sort()) {
    const rel = relative(repoRoot, abs);
    if (seen.has(rel)) continue;
    try {
      if (statSync(abs).size > MAX_BYTES) continue;
      const text = readFileSync(abs, 'utf8');
      // files found only by directory get a cheap sniff before a full parse;
      // a file *named* like a spec is parsed regardless so a broken one is reported
      if (!NAME_RE.test(basename(abs)) && !/(^|\n)\s*"?(openapi|swagger)"?\s*:/.test(text)) continue;
      const parsed = parseSpecText(text, rel);
      seen.add(rel);
      specs.push({ ...parsed, path: rel, text, origin: 'file' });
    } catch (err) {
      // a file named like a spec that does not parse as one is worth a word, not a failure
      if (NAME_RE.test(basename(abs))) errors.push(`openapi ${rel}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return { specs, errors };
}
