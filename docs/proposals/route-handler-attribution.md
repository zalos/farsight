# Routes lose the gates and rules their handler enforces

*Draft for review · 2026-09-06 · from the reference app bug report on `/api/v1/auth/*` drift.*

The reference app reports two drift lines Farsight should not be emitting:

| operation | drift | what the code actually does |
|---|---|---|
| `POST /api/v1/auth/magic-link` | `body-unvalidated` | `expectValid(magicLinkRequestSchema.safeParse(…))` |
| `POST /api/v1/auth/session` | `body-unvalidated` | same shape |
| `GET`/`DELETE /api/v1/auth/session` | `security-missing-in-code` | `requireContractorSession` / `resolveContractorSession`, both `@guard`-tagged |

The report is right that this is a Farsight blind spot and not missing code. It is wrong about the
mechanism, and the workaround it suggests would not have helped.

## 1 · The reported cause does not reproduce

The report attributes it to the `handle(async () => { … })` wrapper: the parse and guard calls sit
in an anonymous callback, and "Farsight does not follow the edge from the verb function into the
callback closure."

Farsight does follow it. `walk()` in `packages/parsers/src/walk.ts` is an unconditional depth-first
walk — the body extraction at `tsjs.ts:224` descends into nested arrow and function expressions
unless the visitor returns `false`, and it never does for call expressions. Ingesting the reported
shape verbatim:

```ts
// app/api/v1/auth/magic-link/route.ts
export async function POST(req: Request) {
  return handle(async () => {
    const body = expectValid(magicLinkRequestSchema.safeParse(await req.json()));
    …
  });
}
```

produces exactly the edges the report says are missing:

```
NODE  function  repro::app/api/v1/auth/magic-link/route.ts::POST
NODE  route     repro::route::POST /api/v1/auth/magic-link
EDGE  calls     repro::route::POST /api/v1/auth/magic-link -> …/route.ts::POST
EDGE  validates repro::lib/schemas.ts::magicLinkRequestSchema -> …/route.ts::POST
EDGE  guards    repro::lib/guards.ts::requireContractorSession -> …/route.ts::GET
```

The closure is not the problem. **The `validates` and `guards` edges land on the exported verb
function, and the drift check reads the route node.**

## 2 · The actual cause: the App Router route node is not the handler

For a Next.js `route.ts`, `tsjs.ts:340-351` emits *two* nodes per verb:

- `repo::route::POST /api/v1/auth/session` — the route, named by the file-system path, and
- `repo::app/api/v1/auth/session/route.ts::POST` — the exported function,

joined by a `calls` edge. Body-level extraction attributes everything it finds — calls, `validates`,
`guards`, db access, branches — to the *function*, because that is the node whose body it walked.

`reconcile()` then asks the route node only, through two helpers that read direct in-edges and stop
there (`packages/core/src/openapi.ts:298-311`):

```ts
function guardsOf(index, routeId)     { return (index.in.get(routeId) ?? []).filter(e => e.kind === 'guards') … }
function validatorsOf(index, routeId) { return (index.in.get(routeId) ?? []).filter(e => e.kind === 'validates') … }
```

The route node has neither, so every App Router operation with a spec-declared body or security
requirement drifts. This is the quirk already recorded in memory, and it is structural: it fires for
**every** App Router route in every repo, regardless of how the handler is written.

**The suggested workaround does not work.** Rewriting the routes to parse and guard directly in the
verb body — the change the foundation agent was told not to make — produces the same result, because
the edges still land on the function:

```
EDGE guards    repro2::lib/guards.ts::requireContractorSession -> …/direct/route.ts::POST
EDGE validates repro2::lib/schemas.ts::magicLinkRequestSchema  -> …/direct/route.ts::POST
```

Nor does `farsight.config.json`: a route-shaped declared guard trades `security-missing-in-code` for
`security-declared-only` (`openapi.ts:321`), which the strict gate also fails.

### 2.1 · The same gap, one step worse, on Express named handlers

An Express route whose handler is a named function rather than an inline arrow is not merely
missing its gates — it has no edge to its handler at all. `tsjs.ts:478-506` handles two argument
shapes, a `require*`/`ensure*`-style middleware call and an inline function expression; a bare
identifier falls through:

```ts
router.post('/session', createSession);
```
```
NODE  function  repro3::src/api.ts::createSession
NODE  route     repro3::route::POST /session        ← orphan: no calls, no guards, no validates
EDGE  guards    repro3::src/guards.ts::requireContractorSession -> repro3::src/api.ts::createSession
EDGE  validates repro3::src/schemas.ts::magicLinkRequestSchema  -> repro3::src/api.ts::createSession
```

The route is a dead end in the graph — it also breaks `trace_flow`, `journey` and impact from that
route, not just drift. Java is unaffected: its route node *is* the method node
(`java/index.ts:339`, `addEdge('guards', guardId, routeId ?? fnId)`).

## 3 · Blast radius — this is not only a drift line

Every consumer asks the same question the same way, so all of them are wrong together for App
Router routes today:

| consumer | site | symptom |
|---|---|---|
| drift | `openapi.ts:315,341` | the two false lines the reference app sees; `farsight gate --strict` fails |
| generated OpenAPI | `openapi.ts:588,605` | `graphToSpec` infers no `security`, no `requestBody` schema |
| APIs tab / CLI `api list` | `openapi.ts:772` | `gates: []`, `gated` count understated |
| viewer node card | `graph-render.js:150,158` | no lock badge, no rule badge on the route card |
| inspector | `graph-render.js:304,332` | empty "Rules & gates" section |
| Journey gates | `query.ts:247-266` | the route stop shows no checkpoint |

So the fix belongs in the graph, not in `reconcile()` — fixing the drift helper alone would leave
five other lenses lying. That is principle 1: one graph, many lenses.

## 4 · Proposed fix

Two changes, both in `packages/parsers/src/tsjs.ts`, both small.

### 4.1 · Record the route → handler pair

Add one map alongside the existing App Router bookkeeping (`tsjs.ts:59-63`):

```ts
// a route that delegates its body to a named function: the handler *is* the route's body
const routeHandlers: { routeId: string; file: string; handler: string }[] = [];
```

- **App Router** (`tsjs.ts:340-351`): where the `calls` edge to `symbolId(file, d.name)` is already
  emitted, also push `{ routeId, file, handler: d.name }`.
- **Express named handler** (`tsjs.ts:480`): for an `Identifier` argument after the path, push
  `{ routeId, file, handler: arg.name }` **and** a `pendingCalls` entry so the route stops being an
  orphan. Middleware identifiers resolve to `guard` nodes and correctly become `guards` edges via
  the existing pass-2 kind mapping, so `router.post('/x', requireAuth, createSession)` works too.

This is a recorded pair, not a heuristic "follow calls from any route" — precision matters, because
blanket call-following would attribute a guard buried in a shared service to every route that
reaches it.

### 4.2 · Mirror the handler's gates and rules onto the route

After pass 2 resolves `pendingCalls` (`tsjs.ts:571-578`), walk the recorded pairs and copy every
`guards`/`validates` edge that targets the handler onto the route:

```ts
for (const rh of routeHandlers) {
  const handlerId = resolveTarget(rh.file, rh.handler);
  if (!handlerId || !nodes.has(rh.routeId)) continue;
  for (const e of edges.filter((e) => e.to === handlerId && (e.kind === 'guards' || e.kind === 'validates'))) {
    const key = `${e.kind}|${e.from}|${rh.routeId}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    addEdge(e.kind, e.from, rh.routeId, { via: 'handler', handler: handlerId });
  }
}
```

**Depth is exactly one hop, by design.** The handler is the route's body — a guard called there is a
guard on the route. A guard two hops away, inside a service the handler calls, is not; attributing
it would make `gated` meaningless. Snapshot the iteration (`[...edges]`) so the appended edges are
not re-read.

`meta.via = 'handler'` keeps the mirrored edge honest and self-describing: the inspector can say
*enforced in `POST()`* rather than implying the check sits on the route line, and it gives the
journey the hook in §5.

### 4.3 · Regression tests

`examples/claims-mini/apps/web/app/api/claims/route.ts` is the natural fixture — it is already the
review-shaped App Router source and currently has neither a guard nor a schema. Add the reported
shape to it (a `@guard`-tagged session check and a zod parse inside a `handle()` callback), then
assert in `packages/parsers/test/openapi.test.ts`:

1. the `guards`/`validates` edges reach **both** the handler function and the route node;
2. the mirrored edges carry `meta.via === 'handler'`;
3. an Express `router.post('/x', namedHandler)` route has a `calls` edge to its handler;
4. `reconcile()` against a spec that declares `security` and a required body reports **no**
   `security-missing-in-code` and **no** `body-unvalidated` for that route.

Point 4 is the one that closes the reference app's report; 1-3 are what stop it recurring.

## 5 · Consequences to accept

- **Journey shows the gate twice.** The walk visits the route stop and then the handler stop, and
  `gatesOf` (`query.ts:247`) would now find the same guard on both. Fix in the same pass: skip a
  gate whose edge carries `meta.via === 'handler'` when that `meta.handler` node is in the graph —
  the handler step follows immediately and carries the real one.
- **New drift, correctly.** A guarded App Router route whose spec declares no security will start
  reporting `security-missing-in-spec`, and one that validates a body the spec omits will report
  `body-undeclared`. Those are true findings that were suppressed by the same blind spot.
- **`graphToSpec` output changes** for App Router repos: inferred `securitySchemes` and a
  `requestBody` `$ref` appear where they were previously absent. Expected; `x-farsight-inferred`
  already marks them.
- **Diffs against existing snapshots show added edges.** Content change only — the
  `farsight-diff v1` shape is untouched.

## 6 · What the reference app should do

Nothing to their route files. The `handle()` pattern is fine and the foundation agent's constraint
was right — restructuring would not have cleared the drift. Once this lands they need a rebuild, a
re-pack, `npm install -g`, a server restart and a re-ingest (`farsight status` reports each step).

## 7 · Follow-ups found in review (landed 2026-09-06)

The pass above landed as specified. Reviewing it turned up three defects in the landed code and
one pre-existing crash that had been blocking the dogfood verification:

1. **A mirrored gate vanished at a truncation boundary.** `gatesOf()` skipped the route's copy
   whenever the handler *node* existed, but the handler *step* is only emitted if the walk gets
   there — `journey(idx, routeId, { maxDepth: 0 })` returned a route with no gate at all. `maxDepth`
   is caller-controlled (`/api/journey?depth=N`, MCP `journey(depth)`), so trimming a journey for
   tokens made an endpoint read as ungated. The dedupe now runs **after** the walk, over the steps
   that were actually emitted, and keeps a gate that also reaches the route directly (middleware).
   `gatesOf()` dedupes by source id as well.
2. **A new false `body-undeclared` on bodiless methods.** `body-unvalidated` excluded
   `GET`/`HEAD`/`DELETE`; `body-undeclared` did not. Once a route inherited its handler's
   `validates`, a GET whose handler zod-parses the query object reported *code validates the request
   body* — a fresh false line for exactly the App Router routes §4 was clearing. Both checks now
   share one `bodiless` test (`openapi.ts:341-347`).
3. **A `'use server'` action crashed ingest.** Pre-existing, not from this pass, but it made
   `farsight ingest .` on this repo fail outright — the reason §6's verification steps could not be
   run. A server action becomes a route node named for the function, with no `METHOD /path`;
   `tsjs.ts:645` destructured it anyway and handed `undefined` to `normalizePath` (a `!` hid it from
   tsc). It now skips a route with no path.

Still open, deliberately: an Express handler written as a member expression
(`router.get('/x', ctrl.list)`) leaves the route an orphan — the `Identifier` branch does not
resolve member chains; and every identifier argument is recorded in `routeHandlers`, middleware
included, so a guard node can nominally act as a handler (unreachable today, since guards carry no
guards of their own).
