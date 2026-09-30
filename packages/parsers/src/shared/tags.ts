import type { NodeKind } from '@farsight/core';

/** Built-in tag heuristics; real deployments define tag rules in farsight.config. */
export function autoTags(file: string, name: string, kind: NodeKind): string[] {
  const tags: string[] = [];
  const hay = `${file} ${name}`.toLowerCase();
  for (const t of ['invoice', 'payment', 'auth', 'customer', 'ledger', 'tax']) {
    if (hay.includes(t)) tags.push(t);
  }
  if (kind === 'component' || kind === 'page') tags.push('ux');
  if (kind === 'table' || kind === 'queue') tags.push('data');
  return tags;
}

/** /invoices/${id}, /invoices/:id and /invoices/{id} all normalize to /invoices/:param — route-stitching key. */
export function normalizePath(p: string): string {
  return p.replace(/:[A-Za-z_]+/g, ':param').replace(/\{[^}/]+\}/g, ':param');
}

/** First lines of an implementation (by source offsets), capped for inspector preview. */
export function snippetRange(source: string, start: number, end: number, maxLines = 14): string {
  const raw = source.slice(start, end);
  const lines = raw.split('\n');
  const clipped = lines.slice(0, maxLines).join('\n');
  return lines.length > maxLines ? clipped + '\n  …' : clipped;
}
