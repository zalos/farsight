// The Next pack's support manifest (PR 14): exactly what this pack reads, for which installed versions. It is data,
// and its canonical digest is the pack digest every control-facts envelope pins, so changing a supported version or
// a rule of the subset invalidates every earlier fact. A version outside `versions` is never analyzed.
import { digestOf } from '../../store/ledger-json.js';
import { deepFreeze } from '../../planner/identity.js';

export const NEXT_PACK_ID = 'sentinel.framework.next';
/** Bumped whenever the pack's semantics change without a manifest change. */
export const NEXT_PACK_REVISION = 1;
export const NEXT_ANALYSIS_SCHEMA = 'sentinel-next-analysis/draft-1' as const;

export const NEXT_SUPPORT = deepFreeze({
  pack: NEXT_PACK_ID,
  revision: NEXT_PACK_REVISION,
  framework: 'next',
  /** Exact installed versions, all three required, from a lockfile. The PR 01 measured candidates and nothing else. */
  versions: { next: '14.2.25', react: '18.3.1', 'react-dom': '18.3.1' },
  versionSources: ['package-lock.json lockfileVersion 2|3', 'pnpm-lock.yaml lockfileVersion 6.0|9.0 importers'],
  router: {
    modelled: 'app',
    appDirectories: ['app', 'src/app'],
    surfaceFiles: ['page.tsx', 'page.ts', 'page.jsx', 'page.js', 'route.ts', 'route.js'],
    segments: ['literal [A-Za-z0-9._~-]', '(group)', '@slot', '[param]', '[...param] last', '[[...param]] last'],
    notRoutable: ['_private'],
    frontier: ['pages router', 'intercepting (.)/(..)/(...) routes', 'encoded or non-ASCII folders', 'route.tsx/route.jsx (no graph surface)'],
  },
  middleware: {
    files: ['middleware.ts', 'middleware.js', 'middleware.tsx', 'middleware.jsx'],
    location: 'beside the router directory: the project root, or src/ when the router lives in src/',
    handler: ['export function middleware', 'export const middleware', 'export default', 'export { middleware | default }'],
    runtimes: ['edge', 'experimental-edge'],
    configKeys: ['matcher', 'runtime', 'regions', 'unstable_allowDynamic'],
  },
  matcher: {
    forms: ['string', 'string[]', '{ source, locale?: boolean }[]'],
    conditional: ['has', 'missing'],
    sourceSegments: ['literal [A-Za-z0-9._~-]', ':name', ':name?', ':name*', ':name+'],
    root: '/ also matches /index',
    caseHandling: 'a decision that changes under case folding is unknown',
    frontier: ['custom (regex) groups', '{} groups', 'escapes', 'partial-segment parameters', 'trailing slash', 'non-literal config', 'as const / satisfies'],
  },
  nextConfig: 'absent, or statically the empty object; any other config leaves every fact unknown',
  effect: 'never established: middleware that runs is not evidence of any property',
});

/** The pack digest: the canonical digest of the manifest. */
export const NEXT_PACK_DIGEST: string = digestOf(NEXT_SUPPORT);
