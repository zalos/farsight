import type { StringEntry } from './strings.js';

// Sentinel's Next middleware pack (PR 14): why a surface's middleware applicability is unknown, which frontiers the pack
// met, and why it refused its inputs. Each key is the stable code a control fact, a frontier or a NextPackError carries.
// Both registers carry the same words until the PR 09 vocabulary freeze, as in strings-sentinel-parser.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_NEXT_STRINGS: Record<string, StringEntry> = {
  // ---- refusals ----
  'sentinel.next.invalidInput': same('the Next pack cannot read these inputs: {detail}', 'The pack reads one valid snapshot, the parser evidence for one of its sources and the captured bytes by their content ids. Evidence for another snapshot or source is refused.'),
  'sentinel.next.integrity': same('the Next pack read bytes that are not what was captured: {detail}', 'Every file the pack reads is checked against the content id capture recorded. A mismatch means nothing it would say could be trusted, so it says nothing.'),
  // ---- why a surface stays unknown ----
  'sentinel.next.reason.effectNotEstablished': same('the middleware runs here; what it does is not established', 'The matcher reaches every request to this page or route, so the middleware runs. Running is not protection: what its code does with the request (let it through, refuse it, check who sent it) is not read, so every property stays unknown.'),
  'sentinel.next.reason.partialMatch': same('the middleware runs for some requests here, not all', 'The matcher reaches some request paths this page or route serves and misses others, so some requests arrive without the middleware running.'),
  'sentinel.next.reason.conditionalMatcher': same('the middleware runs here only under request conditions', 'Only matcher entries with has or missing conditions reach this page or route, so whether the middleware runs depends on headers, cookies or query values of each request.'),
  'sentinel.next.reason.matcherUnsupported': same('the matcher uses a pattern form this pack does not read', 'A matcher entry uses a regular-expression group, a brace group, an escape or a parameter inside a segment. The pack does not approximate it, so a page or route that entry might reach stays unknown.'),
  'sentinel.next.reason.matcherInvalid': same('the matcher is not one Next accepts', 'A matcher entry does not start with a slash, has a key Next does not accept, or is not a valid pattern. Next would refuse it, so nothing is decided from it.'),
  'sentinel.next.reason.matcherDynamic': same('the middleware config is not written as literal values', 'The config export is computed, imported, re-exported or uses syntax such as as const. The pack reads only literal values and never runs the application\'s code, so which requests it matches is unknown.'),
  'sentinel.next.reason.caseAmbiguous': same('whether the matcher reaches this depends on letter case', 'The answer changes when letters are compared without case. The pack does not settle how Next compares case here, so it does not answer.'),
  'sentinel.next.reason.routeUnsupported': same('this page or route\'s path is a form this pack does not read', 'The folder path uses an intercepting route, characters a request would encode, or a catch-all that is not last. Which requests reach it is not modelled.'),
  'sentinel.next.reason.notRoutable': same('Next does not route this file', 'The file sits under a folder whose name starts with an underscore, which Next keeps private. The parser placed it as a page or route; Next serves no request to it.'),
  'sentinel.next.reason.versionUnknown': same('the installed Next version is not known', 'No lockfile this pack reads records which Next, React and React DOM were installed, or the record is ambiguous or disagrees with package.json. A package.json declaration alone is not what was installed, so nothing is decided.'),
  'sentinel.next.reason.versionUnsupported': same('this Next version is not one the pack supports', 'The lockfile records versions other than Next 14.2.25 with React and React DOM 18.3.1, the only combination this pack was measured on. Matching rules differ between versions, so nothing is decided.'),
  'sentinel.next.reason.nextConfigUnsupported': same('next.config may change which requests reach which file', 'A next.config other than an empty object can set a base path, locales, rewrites or page extensions, each of which changes what the middleware sees. The pack does not run it, so nothing is decided.'),
  'sentinel.next.reason.middlewareUnresolved': same('the middleware file could not be read', 'The middleware file was not captured, did not parse, has two candidates or exports no handler the pack can name, so which requests it runs for is unknown.'),
  'sentinel.next.reason.runtimeUnsupported': same('the middleware asks for a runtime this pack does not read', 'Next 14 middleware runs on the edge runtime. A config naming another runtime is outside what was measured.'),
  'sentinel.next.reason.scopeUnknown': same('the router folder was not listed in full', 'Capture did not list the folder that holds the router or the middleware, so the middleware and the pages and routes it would reach are unknown, not absent.'),
  // ---- frontiers ----
  'sentinel.next.frontier.pagesRouter': same('the pages router is not modelled', 'This project also routes files under pages/. The application graph has no surfaces for them, so no fact about them is given.'),
  'sentinel.next.frontier.surfaceNotInGraph': same('a page or route file the graph has no surface for', 'Next serves this file, but the parser placed no page or route for it, for example a route.tsx file or two folders that name the same path. Facts attach only to graph surfaces, so it has none.'),
  'sentinel.next.frontier.outsideApp': same('a page or route surface no Next project routes', 'The parser placed this file as an app-router page or route, but it is not under a Next project\'s router folder, so the pack says nothing about it.'),
  'sentinel.next.frontier.misplacedMiddleware': same('a middleware file Next does not load', 'Next loads middleware only beside the router folder. This file sits elsewhere, so it never runs; it is listed so nobody mistakes it for the project\'s middleware.'),
  'sentinel.next.frontier.factLimit': same('more pages and routes than one envelope holds', 'The project has more surfaces than fit in one control-facts envelope. The remainder carries no facts and is unknown.'),
  'sentinel.next.frontier.packageJsonInvalid': same('a package.json that could not be read', 'The file is too large, not valid UTF-8 or not a JSON object, so whether it declares a Next project is unknown.'),
  'sentinel.next.frontier.noRouter': same('a Next project with no router folder', 'The package.json declares Next, but no app/ or pages/ folder was captured beside it or in src/, so there is nothing to route.'),
  'sentinel.next.frontier.directoryUnlisted': same('a router folder whose contents were not listed', 'Capture did not list this folder, so pages, routes or middleware inside it are unknown, not absent.'),
};

export function sentinelNextWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_NEXT_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
