import type { StringEntry } from './strings.js';

// The Express framework pack (PR 15): why a control fact about an Express route is unknown. Each key is the stable
// reason code an unknown fact or a frontier carries. Both registers carry the same words until the PR 09
// vocabulary freeze, as in strings-sentinel-capture.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_EXPRESS_STRINGS: Record<string, StringEntry> = {
  // ---- version and source scope ----
  'sentinel.express.versionUnresolved': same('the Express version could not be read exactly', 'The pack reads the version from the captured package manifest, and from the npm lockfile when the manifest gives a range. Without an exact resolution to the version it models, it cannot say which routing behaviour applies, so the fact stays unknown.'),
  'sentinel.express.versionUnsupported': same('an Express version this pack does not model', 'The pack models exactly Express 4.21.2. Another version, or an override of it, could route requests differently, so the fact stays unknown.'),
  'sentinel.express.sourceIncomplete': same('some source the pack needs was not captured', 'A source file or a folder that capture did not keep or list could register another layer before a route, so what runs before its handler stays unknown.'),
  'sentinel.express.sourceNotUtf8': same('the source is not valid UTF-8, so it cannot be cited', 'Evidence points at exact byte ranges of the captured file. This file is not exact UTF-8, so no range can be computed and the fact stays unknown.'),
  'sentinel.express.scanLimit': same('the source scan reached its limit', 'The pack reads a bounded number of source files and bytes. Files past the limit were not read, so a layer they register would be missed; affected facts stay unknown.'),
  'sentinel.express.syntaxError': same('a source file could not be read cleanly', 'The file has a syntax error where an application or router could be configured, so the pack cannot be sure it found every layer.'),
  // ---- registration ----
  'sentinel.express.registrationDynamic': same('an application or router is configured in a way this pack does not follow', 'The pack reads registrations written as top-level statements in source order. This application or router is also registered on inside a function, branch or loop, passed to other code, reassigned or used from another module, so the layers it holds are not known.'),
  'sentinel.express.registrationUnsupported': same('a registration this pack does not read', 'The call registers handlers through a shape the pack does not interpret, such as spread arguments or a route chain, so what it does for this route is unknown.'),
  'sentinel.express.pathUnsupported': same('a path this pack does not read', 'The pack reads literal path segments and whole-segment parameters. A wildcard, an optional or repeated parameter, a regular expression, a list of paths, a trailing slash or a path computed at run time is not interpreted.'),
  'sentinel.express.layerMatchUnknown': same('a layer may run for only some requests to this route', 'The layer\'s path or method matches some of the requests this route receives and not others, so whether it runs before the handler depends on the request.'),
  'sentinel.express.routingSettingUnsupported': same('routing is configured in a way this pack does not model', 'Case-sensitive or strict routing, or a router option other than merging parameters, changes which paths match. The pack models the defaults only.'),
  'sentinel.express.subAppUnsupported': same('an application is mounted inside another application', 'A mounted application has its own settings and mount behaviour, which the pack does not model, so what runs before its routes is unknown.'),
  'sentinel.express.paramCallback': same('a parameter callback runs before this route', 'A callback registered for route parameters runs before handlers whose path has a parameter. Its behaviour is not read.'),
  'sentinel.express.routeNotMounted': same('the route\'s router is not mounted on any application', 'No application in the captured source mounts this router, so whether and where it serves requests is unknown.'),
  'sentinel.express.routeObjectUnresolved': same('the route is registered on something the pack cannot identify', 'The object the route is registered on could not be traced to an Express application or router in the captured source, so its layers are unknown.'),
  'sentinel.express.surfaceAmbiguous': same('several registrations share this route', 'More than one registration has the same method and path, and the graph has one surface for them, so the facts of one cannot stand for the others.'),
  'sentinel.express.mountsDisagree': same('the route is reached through mounts that differ', 'The route\'s router is mounted on several paths, and the layers before the handler are not the same on each, so no single answer holds for it.'),
  'sentinel.express.routeNotIndexed': same('the route could not be placed in the captured source', 'The parser\'s route has no exact location in a captured file, so no evidence for it can be cited.'),
  'sentinel.express.mountCycle': same('routers are mounted in a cycle', 'A router is mounted, directly or through others, inside itself, so the path a request takes cannot be followed.'),
  // ---- middleware ----
  'sentinel.express.middlewareUnresolved': same('a middleware function could not be found in the captured source', 'The function registered here could not be traced to a definition in the captured source, so what it does is unknown.'),
  'sentinel.express.middlewareThirdParty': same('a middleware function comes from a library', 'The function registered here comes from a package other than Express. Its behaviour depends on that package and is not read, whatever its name suggests.'),
  'sentinel.express.middlewareEffectUnknown': same('what a middleware function does is not read', 'The pack reads three shapes: one refusal with a fixed status when a request value is absent or differs, then passing the request on; a function that only passes the request on; and an error handler. This function is something else, so its effect is unknown, whatever its name suggests.'),
  'sentinel.express.errorPathResumes': same('an error handler after this check can let a request past it', 'When a layer raises an error, Express skips the ordinary layers after it until an error handler; if that handler passes the request on without the error, routing continues after it. A handler registered after this check, or a layer that could be one, can resume a request that skipped the check, so the check does not hold for every request.'),
  'sentinel.express.nextSkip': same('a middleware function can skip the rest of a route or router', 'The function can tell Express to skip the remaining handlers of the route or the remaining layers of the router. That changes which layers run, and is not read.'),
};
