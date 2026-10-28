// The read model's HTTP routes on Sentinel's loopback host (Sentinel v2 §9, lane L-UX U-1). Farsight's server imports
// no Sentinel code (ADR 18): the viewer fetches these from the owner companion's own origin, cross-origin, with the
// read pass the paired owner frame hands it. Every route reads; anything but GET (and the CORS preflight) is refused.
// The routes map to the companion's closed owner-ui read operations and to nothing else: no generic RPC. A scan is
// addressed by its run id (its number is a display ordinal only), a stage by its id, a check or review by its place
// in the stage; the list pages backwards with a cursor, the number of the oldest scan the previous page showed.
//
//   GET /api/sentinel/scans                                   the newest page of scans
//   GET /api/sentinel/scans/before/<n>                        the page of scans numbered below n
//   GET /api/sentinel/scans/<run id>                          one scan's PIPELINE
//   GET /api/sentinel/scans/<run id>/stages/<stage>           one STAGE
//   GET /api/sentinel/scans/<run id>/stages/<stage>/units/<k> one check or review of it, opened
//   GET /api/sentinel/scans/<run id>/report[/md|html|json|sarif]   the retained report, rendered

/** One read the address names: the owner-ui operation and its body, or a report rendering. */
export type ReadRoute =
  | { readonly kind: 'scans'; readonly before: number | null }
  | { readonly kind: 'scan'; readonly runId: string }
  | { readonly kind: 'stage'; readonly runId: string; readonly stage: string }
  | { readonly kind: 'unit'; readonly runId: string; readonly stage: string; readonly unit: number }
  | { readonly kind: 'report'; readonly runId: string; readonly format: ReportFormatName };

export const REPORT_FORMAT_NAMES = ['md', 'html', 'json', 'sarif'] as const;
export type ReportFormatName = (typeof REPORT_FORMAT_NAMES)[number];

export const READ_PREFIX = '/api/sentinel/';
const NUMBER = /^[1-9][0-9]{0,8}$/;
/** The owner-ui run id shape; `before` is the list's cursor word, never a run. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STAGE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** True when an address is one of the read model's (whatever the method). */
export const isReadModelPath = (url: string | undefined): boolean =>
  typeof url === 'string' && url.startsWith(READ_PREFIX);

const decoded = (part: string): string | null => {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

/** The read an address names, or null for an address the read model does not answer. Query strings never parse. */
export function readRoute(url: string): ReadRoute | null {
  if (!isReadModelPath(url) || url.includes('?') || url.includes('#') || url.length > 512) return null;
  const parts = url.slice(READ_PREFIX.length).split('/');
  if (parts[0] !== 'scans') return null;
  if (parts.length === 1) return { kind: 'scans', before: null };
  if (parts[1] === 'before')
    return parts.length === 3 && NUMBER.test(parts[2]!) ? { kind: 'scans', before: Number(parts[2]) } : null;
  const runId = parts[1]!;
  if (!RUN_ID.test(runId)) return null;
  if (parts.length === 2) return { kind: 'scan', runId };
  if (parts[2] === 'stages' && (parts.length === 4 || parts.length === 6)) {
    const stage = decoded(parts[3]!);
    if (stage === null || !STAGE.test(stage)) return null;
    if (parts.length === 4) return { kind: 'stage', runId, stage };
    return parts[4] === 'units' && NUMBER.test(parts[5]!)
      ? { kind: 'unit', runId, stage, unit: Number(parts[5]) }
      : null;
  }
  if (parts[2] === 'report' && parts.length === 3) return { kind: 'report', runId, format: 'md' };
  if (parts[2] === 'report' && parts.length === 4 && (REPORT_FORMAT_NAMES as readonly string[]).includes(parts[3]!))
    return { kind: 'report', runId, format: parts[3] as ReportFormatName };
  return null;
}

/** The owner-ui operation and body that answer a route (the companion adds its pairing proof and view revision). */
export function routeOperation(route: ReadRoute): { readonly op: string; readonly body: Record<string, unknown> } {
  switch (route.kind) {
    case 'scans':
      return { op: 'owner-ui.scans', body: route.before === null ? {} : { before: route.before } };
    case 'scan':
      return { op: 'owner-ui.scan', body: { runId: route.runId } };
    case 'stage':
      return { op: 'owner-ui.stage', body: { runId: route.runId, stage: route.stage } };
    case 'unit':
      return { op: 'owner-ui.unit', body: { runId: route.runId, stage: route.stage, unit: route.unit } };
    case 'report':
      return { op: 'owner-ui.scan-report', body: { runId: route.runId, format: route.format } };
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
