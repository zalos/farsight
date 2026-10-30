/**
 * Find the OpenAPI/Swagger documents that describe a repo: by filename
 * (`openapi.*`, `swagger.*`, `api*.yaml`, anything under an `openapi/` dir)
 * then by content (must parse as a spec), plus whatever
 * `farsight.config.json → openapi` declares (paths or URLs — the config is
 * how "the API itself" gets registered as a source of truth for its shape).
 */
import { closeSync, openSync, readSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, basename, resolve, isAbsolute } from 'node:path';
import { t } from '@farsight/core';
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
  origin: 'file' | 'config' | 'settings';
  status: 'applied' | 'candidate';
  phase?: string;
  phaseOrder?: string[];
}

export interface OpenApiDeclaration {
  path?: string;
  url?: string;
  name?: string;
  phase?: string;
  phaseOrder?: string[];
}

/** Inspect only the prefix, without parsing unrelated JSON or YAML documents. */
function hasSpecKey(head: string): boolean {
  if (!head.trimStart().startsWith('{'))
    return /^(?:openapi|swagger|"openapi"|"swagger"|'openapi'|'swagger')\s*:/m.test(head);
  // JSON keys may be on the first line, after other fields, or inside nested objects.
  // Only an object key at depth one counts; a quoted example in a description does not.
  let depth = 0;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === '"') {
      const start = i++;
      for (; i < head.length; i++) {
        if (head[i] === '\\') i++;
        else if (head[i] === '"') break;
      }
      if (depth === 1 && /^\s*:/.test(head.slice(i + 1)) && /^"(?:openapi|swagger)"$/.test(head.slice(start, i + 1)))
        return true;
    }
  }
  return false;
}

function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(2048);
    return head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function insideSource(root: string, path: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(path));
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

export async function discoverSpecs(
  repoRoot: string,
  options: IngestOptions,
  declared: OpenApiDeclaration[] = [],
): Promise<{ specs: DiscoveredSpec[]; errors: string[] }> {
  const specs: DiscoveredSpec[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const keyOf = (ref: string) =>
    isSpecUrl(ref) ? ref : relative(repoRoot, resolve(repoRoot, ref)).replaceAll('\\', '/');
  const ignored = new Set((options.openapiIgnored ?? []).map(keyOf));

  // declared first — they win over discovery for the same path
  const declarations = [
    ...declared.map((d) => ({ ...d, origin: 'config' as const })),
    ...(options.openapiRegistered ?? []).map((d) => ({ ...d, origin: 'settings' as const })),
  ];
  for (const d of declarations) {
    const ref = d.url ?? d.path;
    if (!ref) continue;
    const key = keyOf(ref);
    if (ignored.has(key) || seen.has(key)) continue;
    seen.add(key);
    try {
      if (!isSpecUrl(ref)) {
        const path = resolve(repoRoot, ref);
        if (!insideSource(repoRoot, path)) throw new Error(t('config.openapi.outsideSource', 'professional'));
        if (statSync(path).size > MAX_BYTES) throw new Error(t('config.openapi.tooLarge', 'professional'));
      }
      const parsed = await readSpecSource(ref, repoRoot);
      specs.push({
        ...parsed,
        path: key,
        origin: d.origin,
        status: 'applied',
        ...(d.name ? { name: d.name } : {}),
        ...(d.phase ? { phase: d.phase } : {}),
        ...('phaseOrder' in d && d.phaseOrder ? { phaseOrder: d.phaseOrder } : {}),
      });
    } catch (err) {
      // a declaration that names no file says so in words, without the absolute path the error carries
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      errors.push(
        `openapi ${ref}: ${missing ? t(d.origin === 'settings' ? 'config.openapi.missingSettings' : 'config.openapi.missingConfig', 'professional') : (err as Error).message.split('\n')[0]}`,
      );
    }
  }

  for (const abs of collectFiles(repoRoot, ['.yaml', '.yml', '.json'], options).sort()) {
    const rel = keyOf(abs);
    if (seen.has(rel) || ignored.has(rel)) continue;
    const named = NAME_RE.test(basename(abs));
    const underOpenapi = /(^|\/)openapi\//.test(rel);
    try {
      if (!insideSource(repoRoot, abs) || statSync(abs).size > MAX_BYTES) continue;
      // Preserve errors for spec-named files. Everything else needs a top-level key
      // in its first 2 KiB before we read the body and attempt a parse.
      if (!named && !hasSpecKey(readHead(abs))) continue;
      const text = readFileSync(abs, 'utf8');
      const parsed = parseSpecText(text, rel);
      seen.add(rel);
      specs.push({
        ...parsed,
        path: rel,
        text,
        origin: 'file',
        status: named || underOpenapi ? 'applied' : 'candidate',
      });
    } catch (err) {
      // a file named like a spec that does not parse as one is worth a word, not a failure
      if (named) errors.push(`openapi ${rel}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return { specs, errors };
}
