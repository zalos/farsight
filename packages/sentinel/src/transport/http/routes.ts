// The read model's HTTP routes on Sentinel's loopback host (Sentinel v2 §9, lane L-UX U-1). Farsight's server imports
// no Sentinel code (ADR 18): the viewer fetches these from the owner companion's own origin, cross-origin, with the
// read pass the paired owner frame hands it. Every route reads; anything but GET (and the CORS preflight) is refused.
// The routes map to the companion's closed owner-ui read operations and to nothing else: no generic RPC, no id from
// the address reaches the store. A scan is addressed by its number in the workspace's list, a stage by its id.

/** One read the address names: the owner-ui operation and its body, or a report rendering. */
export type ReadRoute =
  | { readonly kind: 'scans' }
  | { readonly kind: 'scan'; readonly number: number }
  | { readonly kind: 'stage'; readonly number: number; readonly stage: string }
  | { readonly kind: 'report'; readonly number: number; readonly format: ReportFormatName };

export const REPORT_FORMAT_NAMES = ['md', 'html', 'json', 'sarif'] as const;
export type ReportFormatName = (typeof REPORT_FORMAT_NAMES)[number];

export const READ_PREFIX = '/api/sentinel/';
const NUMBER = /^[1-9][0-9]{0,8}$/;
const STAGE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** True when an address is one of the read model's (whatever the method). */
export const isReadModelPath = (url: string | undefined): boolean =>
  typeof url === 'string' && url.startsWith(READ_PREFIX);

/** The read an address names, or null for an address the read model does not answer. Query strings never parse. */
export function readRoute(url: string): ReadRoute | null {
  if (!isReadModelPath(url) || url.includes('?') || url.includes('#') || url.length > 512) return null;
  const parts = url.slice(READ_PREFIX.length).split('/');
  if (parts[0] !== 'scans') return null;
  if (parts.length === 1) return { kind: 'scans' };
  if (!NUMBER.test(parts[1]!)) return null;
  const number = Number(parts[1]);
  if (parts.length === 2) return { kind: 'scan', number };
  if (parts[2] === 'stages' && parts.length === 4) {
    let stage: string;
    try {
      stage = decodeURIComponent(parts[3]!);
    } catch {
      return null;
    }
    return STAGE.test(stage) ? { kind: 'stage', number, stage } : null;
  }
  if (parts[2] === 'report' && parts.length === 3) return { kind: 'report', number, format: 'md' };
  if (parts[2] === 'report' && parts.length === 4 && (REPORT_FORMAT_NAMES as readonly string[]).includes(parts[3]!))
    return { kind: 'report', number, format: parts[3] as ReportFormatName };
  return null;
}

/** The owner-ui operation and body that answer a route (the companion adds its pairing proof and view revision). */
export function routeOperation(route: ReadRoute): { readonly op: string; readonly body: Record<string, unknown> } {
  switch (route.kind) {
    case 'scans':
      return { op: 'owner-ui.scans', body: {} };
    case 'scan':
      return { op: 'owner-ui.scan', body: { number: route.number } };
    case 'stage':
      return { op: 'owner-ui.stage', body: { number: route.number, stage: route.stage } };
    case 'report':
      return { op: 'owner-ui.scan-report', body: { number: route.number, format: route.format } };
  }
}

/** The media type a report rendering is delivered as. */
export const REPORT_MEDIA: Readonly<Record<ReportFormatName, string>> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  sarif: 'application/sarif+json',
};

/**
 * The CORS headers a read answer carries: only for the exact paired Farsight origin, never a wildcard and never
 * credentials (the pass travels in the Authorization header, never a cookie). An answer to any other origin carries
 * none, so the browser refuses it to that page.
 */
export function corsHeaders(requestOrigin: unknown, farsightOrigin: string): Record<string, string> {
  if (requestOrigin !== farsightOrigin) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': farsightOrigin,
    'access-control-expose-headers': 'x-sentinel-format-digest, content-disposition',
    vary: 'Origin',
  };
}

/** The preflight answer for a read: GET with the Authorization header, from the paired origin only. */
export function preflightHeaders(requestOrigin: unknown, farsightOrigin: string): Record<string, string> | null {
  if (requestOrigin !== farsightOrigin) return null;
  return {
    ...corsHeaders(requestOrigin, farsightOrigin),
    'access-control-allow-methods': 'GET',
    'access-control-allow-headers': 'authorization',
    'access-control-max-age': '600',
  };
}
