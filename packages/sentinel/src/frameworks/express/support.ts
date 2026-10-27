// What the Express pack models, stated as data. It is part of the pack digest, so a change to the supported subset
// invalidates every fact computed under the old one. Anything not listed here is reported as unknown with a reason.
export const EXPRESS_SUPPORT = Object.freeze({
  versions: Object.freeze({
    express: '4.21.2',
    source:
      "the root package.json depends on express exactly 4.21.2, or on a range the npm lockfile (v2 or later, written for that declaration) resolves to exactly 4.21.2; overrides or resolutions naming express, a range with only another lockfile, a TypeScript path alias for express, or any registration on a route's path (an application, router, layer or middleware) in a file under a nested package manifest, is unknown",
  }),
  modules:
    "ES imports and exports, top-level require of a literal specifier, module.exports and exports.x assigned at the top level; relative specifiers resolve to one captured file (TypeScript's .js-for-.ts convention included); star re-exports, mixed module systems and anything else are unresolved",
  objects:
    'applications from express() and routers from express.Router() or Router(), each a top-level const; router options other than mergeParams, and the case sensitive or strict routing settings, leave path matching unknown',
  registration:
    'top-level statements X.use(...), X.<method>(path, ...), X.all(path, ...), X.route(path).<method>(...), X.param(...), in source order; any other use of an application or router (a registration in a function, branch or loop, the object passed to a function, assigned or registered on elsewhere) makes the object open and every route it could reach unknown; exporting it, listen() and createServer() are allowed',
  dispatch:
    "a request passes through the layers registered before the route on the application and on every router mounted on its path, in order: use() layers whose prefix matches, earlier routers whose prefix matches (their own matching layers), earlier routes that match the same method and path (their handlers), then the route's own handlers before the last; layers registered after the route never run before it",
  mounts:
    'routers mounted with a literal path; a router mounted on several paths is evaluated on each and must agree; an application mounted in another application, an unmounted router and a mount cycle are unknown',
  paths:
    'literal segments and whole-segment :name parameters, case-insensitive and non-strict as Express 4.21.2 matches by default; wildcards, optional or repeated parameters, regular expressions, path arrays and trailing slashes are unknown, and a match that holds for some requests only is unknown',
  methods: 'get also answers HEAD; all matches every method',
  effects: Object.freeze({
    refusal:
      'a non-async function (req, res, next) whose body is one if without else, on !v, v == null, v === undefined or v !== literal (v a request property read or req.get/header of a literal), responding res.status(401|403).json|send|end(literals) or res.sendStatus(401|403) and returning, then next(); a factory that only returns such a function, called with literal arguments, is read; it is evidence of a conditional refusal at its position and leaves both properties unknown there, because neither the status nor the request value shows a principal or a permission',
    passThrough:
      "Express's own json, urlencoded, text, raw and static with literal options, or a function whose statements only call code with plain request values (method, url, path, ...) and end with next()",
    errorOnly:
      'a four-parameter function runs only with an error and holds no position on the normal path; because Express skips the ordinary layers after an error until an error handler, a refusal followed by an error handler that may call next() without the error, or by a layer whose parameters are not known, is cited as errorPathResumes',
    unknown:
      "third-party or unresolved middleware, async functions, next('route') or next('router'), any other body, and param callbacks before a route with a parameter",
  }),
  facts:
    "per route and property: never applies; unknown at the position of each refusal (refusalUnproven, citing it) and of each layer that cannot be read; does-not-apply at the handler's position (the number of layers before it) when every layer before it was read and none can refuse; names, status codes and request values never establish a principal or permission",
  gaps: "every route this pack discovers is reconciled with the parser's route surfaces; a route() chain, an all() route or a route on an object the parser does not index gets no fact and is a frontier (registrationUnsupported or routeNotInGraph), never omitted silently",
  notSupported: Object.freeze([
    'Express 5',
    'sub-applications',
    'routes in test sources',
    'what populates the request values a refusal reads',
    'router.route() stacks',
    'runtime configuration and environment branches',
  ]),
});
