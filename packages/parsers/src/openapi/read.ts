/**
 * Reading OpenAPI / Swagger documents: YAML or JSON text → parsed object plus
 * a `lineOf(path, method)` locator so a contract can deep-link into the file
 * (⧉ at the operation's line). `yaml` is the one dependency (pure JS); core
 * receives parsed objects only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument, LineCounter, stringify, isMap, isPair, isScalar } from 'yaml';
import { isOpenApiDoc, type OpenApiDoc } from '@farsight/core';

export interface ParsedSpec {
  doc: OpenApiDoc;
  lineOf: (path: string, method: string) => number | undefined;
  format: 'yaml' | 'json';
}

/** Parse spec text (JSON or YAML, sniffed). Throws with a readable message when the text is neither, or is not an OpenAPI/Swagger document. */
export function parseSpecText(text: string, label = 'spec'): ParsedSpec {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let doc: unknown;
    try { doc = JSON.parse(text); } catch (err) { throw new Error(`${label}: not valid JSON — ${(err as Error).message}`); }
    if (!isOpenApiDoc(doc)) throw new Error(`${label}: JSON is not an OpenAPI 3.x / Swagger 2.0 document (needs "openapi"/"swagger" and "paths")`);
    return { doc, lineOf: jsonLineLocator(text), format: 'json' };
  }
  const counter = new LineCounter();
  const ydoc = parseDocument(text, { lineCounter: counter, uniqueKeys: false });
  if (ydoc.errors.length) throw new Error(`${label}: YAML error — ${ydoc.errors[0]!.message.split('\n')[0]}`);
  const doc = ydoc.toJS({ maxAliasCount: -1 }) as unknown;
  if (!isOpenApiDoc(doc)) throw new Error(`${label}: not an OpenAPI 3.x / Swagger 2.0 document (needs openapi:/swagger: and paths:)`);
  const lineOf = (path: string, method: string): number | undefined => {
    // the line of the `get:` key itself (the value node starts one line lower)
    const item = ydoc.getIn(['paths', path], true);
    if (!isMap(item)) return undefined;
    const pair = item.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === method);
    const key = pair && isPair(pair) && isScalar(pair.key) ? pair.key : undefined;
    return key?.range ? counter.linePos(key.range[0]).line : undefined;
  };
  return { doc, lineOf, format: 'yaml' };
}

/** Best-effort line locator for JSON specs: the `"<path>":` key's line, then the first `"<method>":` after it. */
function jsonLineLocator(text: string): ParsedSpec['lineOf'] {
  const lines = text.split('\n');
  return (path, method) => {
    const pathKey = JSON.stringify(path) + ':';
    const methodKey = `"${method}"`;
    let i = lines.findIndex((l) => l.includes(pathKey));
    if (i < 0) return undefined;
    for (let j = i; j < Math.min(lines.length, i + 400); j++) {
      if (lines[j]!.trimStart().startsWith(methodKey)) return j + 1;
    }
    return i + 1;
  };
}

export function isSpecUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Read a spec from a file path or a URL ("the API itself" — the document a
 * running service publishes). Fails loudly with the reason; callers decide
 * whether to degrade.
 */
export async function readSpecSource(pathOrUrl: string, cwd = process.cwd()): Promise<ParsedSpec & { text: string }> {
  let text: string;
  if (isSpecUrl(pathOrUrl)) {
    const res = await fetch(pathOrUrl, { headers: { accept: 'application/json, application/yaml, text/yaml, */*' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${pathOrUrl}: HTTP ${res.status}`);
    text = await res.text();
  } else {
    text = readFileSync(resolve(cwd, pathOrUrl), 'utf8');
  }
  return { ...parseSpecText(text, pathOrUrl), text };
}

/** Serialize a document as YAML (generated specs). */
export function specToYaml(doc: OpenApiDoc): string {
  return stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
}
