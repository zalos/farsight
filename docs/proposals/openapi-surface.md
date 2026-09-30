# OpenAPI surface — APIs as first-class, explorable, checkable

**Date:** 2026-09-04 · **Status:** landed 2026-09-05 (branch `feat/openapi-surface`, merged to main) — acceptance §6 items 1–5 verified: fixture drift on routes/CLI/MCP/viewer, generate→reconcile round trip = 0 drift (test), Contract links in Journeys + Code map inspector, `stitchHttp` MEDIUM across sources (test), `pnpm -r test` 38 green + `lint:strings` ok
**Ask:** make APIs explorable through OpenAPI — view an API from a spec file *or* from the API itself, generate a spec from code, compare a proposed spec against the code and surface the gaps, give APIs and their consumers a section of their own, and let Journeys and the Code map deep-link into the spec visualization and the spec file.

---

## 1 · What each audience needs from this

| Persona | The question they bring | What this pass gives them |
|---|---|---|
| **Dana** (senior dev) | "What does `POST /invoices` accept and return, who calls it, and is the spec lying?" | Contract panel on the route (params · body · responses · security · spec line), the consumer list with the exact client call site, and per-operation drift chips. |
| **Priya** (PM) | "What can the billing API *do*, which screens use it, and is it documented?" | The API page in the business lens: operations by tag with the spec's own plain-language summaries (the best business text we have ever had — spec authors write for consumers), screens that reach each operation, `undocumented` / `not implemented` chips in words. |
| **Marcus** (architect) | "Which services expose what, who depends on whom across repos, where is the contract drifting?" | The APIs atlas: one card per API surface (spec-backed or implied by code), consumers across sources, drift counts, and a spec generated from code for every repo that serves routes but never wrote one. |
| **Ops / compliance** | "Which operations declare security the code does not enforce — and vice versa?" | `security-mismatch` drift computed from `guards` edges vs the spec's `security` requirements; every ungated declared operation is a row, not a percentage. |
| **Coding agents** | "Give me the contract for this route, then tell me what my proposed spec breaks." | MCP `api_surface`, `api_drift`, `api_spec`; `describe_node` on a route prints the contract. |
| **CI** | "Fail the build when the spec and code disagree." | `farsight api diff --spec openapi.yaml --strict` (exit 1 on drift), same JSON the viewer renders. |

## 2 · Decisions (with the revision that produced them)

The first draft of this plan had a new `operation` node kind, a separate "spec artifact" store, and a swagger-style UI. Thinking it through against the four core principles changed all three:

**D1 · Routes are the operations; the spec augments them.** *(revised from: a separate `operation` kind)*. A spec is documentation about HTTP endpoints — principle 2 says docs augment what parsing found and never replace it. So an OpenAPI operation lands on the **same node id** the code adapters use, `repo::route::METHOD /path`, and gains a `contract` field. One id whether the evidence is code, spec, or both; `contract.status` says which (`both` · `spec-only` · `code-only`). Journeys, impact, diff, MCP, and the Code map all keep working on spec-declared routes without a single special case.

**D2 · One `api` node per spec document; implied APIs are synthesized at query time, never persisted.** Marcus needs a service-level thing to click and the drift report needs a subject. But a repo that serves routes without a spec has no *evidence* of an API document — so `apiSurface()` returns an implied surface (`<repo>::api::implemented`, labelled "no spec on file") computed from its routes rather than inventing a node. The graph records evidence; the lens draws the fog.

**D3 · Drift is computed once at ingest and stored on the route; the ad-hoc "proposed spec" path calls the same function.** `reconcile(spec, index)` is the only place that decides *matched / spec-only / code-only / mismatch*. Ingest stores its result as `contract.drift` so viewer, MCP, and CLI all show identical facts; `POST /api/apis/diff` and `farsight api diff` run the same function on a spec that is not in the repo and return the same report shape without persisting anything. Two doors, one truth.

**D4 · Consumers are the existing `http` edges — and unresolved fetches stop being dropped.** *(revised from: consumers only within one fragment)*. A spec's consumers usually live in another repo. Today an unmatched `fetch('/invoices')` is silently discarded, so the API page would show a lonely server. Now: an unmatched relative call becomes an `unknown` stub (`repo::unknown::METHOD /path`, `resolution.status='unresolved'`) — the "?" stub P4 already reserved in the diff schema — and a store-level `stitchHttp()` re-points those edges when any other source (code *or* spec) declares the route, stamping `technique:'fetch→route', confidence:'MEDIUM'` (path-only match, no host check; same-fragment matches stay HIGH). An absolute URL to another host becomes an `external` node named by host. This is P4 §2.5 step 1 pulled forward and scoped to HTTP; P4 owns the rest.

**D5 · Generated specs are honest about what was inferred.** `graphToSpec()` emits only what the graph knows and marks the rest: `x-farsight-source: "src/server/routes.ts:12"` on every operation, `x-farsight-inferred: ["responses"]` where a default was filled in, `security` derived from `guards` edges with the guard named, request bodies from `validates` edges (property names lifted from the zod object literal when it is parsable, otherwise a description), and `info.x-farsight` provenance (sync · commit · generatedAt · tz). Round trip is a test: generate → reconcile against the same graph → zero drift.

**D6 · Business text comes from the spec when the code has none.** `businessSummary()` gains one more rung: `@business` → doc summary → `contract.summary`. Express routes have no doc comment of their own (the handler does), so the spec summary is what the business lens will show for them — and it is exactly the sentence the API's authors wrote for its consumers.

**D7 · "From the API itself" means the spec the API serves, not crawling it.** A source can be a URL (`https://host/openapi.json`) or a file; the server fetches it at sync. Probing live endpoints to discover them is out of scope (stated, not implied).

**D8 · `yaml` (pure JS) is the one new dependency, in `packages/parsers`.** Specs are overwhelmingly YAML; a hand-rolled subset parser would be the fragile kind of honesty. The dependency is pure JS, inlines into the tarball via esbuild, and keeps the "no native modules in the install path" posture (ADR 6/7). `core` stays dependency-free: it receives parsed objects.

## 3 · Model

```ts
// core/graph.ts
type NodeKind = … | 'api' | 'unknown';   // api = one spec document; unknown = the "?" stub

interface OperationContract {
  status: 'both' | 'spec-only' | 'code-only';
  apiId: string;                          // owning api node (or implied surface id)
  spec?: { path: string; line?: number; operationId?: string };   // ⧉ into the spec file
  summary?: string; description?: string; deprecated?: boolean; tags?: string[];
  params?: { name; in: 'path'|'query'|'header'|'cookie'; required?; type?; description? }[];
  requestBody?: { contentType?; schema?; required?; fields?: string[] };
  responses?: { status: string; description?; schema? }[];
  security?: string[];                    // "bearer", "oauth2: billing:write"
  drift?: { kind: DriftKind; message: string }[];
}
type DriftKind = 'spec-only' | 'code-only' | 'security-missing-in-code' | 'security-missing-in-spec'
               | 'path-params' | 'deprecated-in-spec-only' | 'body-undeclared';

interface GraphNode { …; contract?: OperationContract }   // route nodes only
```

Edges: `api --contains--> route`. Consumers: `function --http--> route` (existing), now also cross-source after `stitchHttp()`.

Matching rule (`reconcile`): normalize both sides with the existing `normalizePath` (`{id}` · `:id` · `${id}` → `:param`); exact method+path match first; then with each `servers[].url` path prefix added/removed (`matchedBy:'basePath'`, reported); never fuzzier than that.

## 4 · Surfaces

**Viewer — new nav tab `#/apis`** (HUD "Trade Routes" · professional "APIs"; the fifth tab, role-landing capable):
- `#/apis` — one card per API surface in scope: title, version, source (spec file ⧉ / URL / "implied from code — no spec on file"), operations · consumers · drift counts with definition tooltips (numbers name their definition; P3's metric objects take these over when they land).
- `#/apis/<apiId>` — operations grouped by spec tag; each row: method chip, path, summary (business lens: summary only; code lens: operationId + spec line), gate chips, consumer count, drift chips in words (`not implemented` · `undocumented` · `security mismatch`). Buttons: *Journey* (`#/journeys/<routeId>`), *Code map* (`#/codemap?node=<routeId>`), *Spec* (`?view=spec&line=N`).
- `#/apis/<apiId>?op=<routeId>` — the operation panel: contract (params · body · responses · security), consumers with the client function, its call-site `file:line` ⧉ and the screens upstream of it, drift, source ⧉.
- `#/apis/<apiId>?view=spec[&line=N]` — the spec file itself with line numbers and the operation's lines highlighted (hidden in the business lens; the business lens shows the operations table).
- **Compare a proposed spec** drawer on every API page: paste text or give a URL → `POST /api/apis/diff` → drift table. READ-ONLY: nothing is stored.
- Back-links: route cards in Journeys and the Code map inspector get a *Contract* section/link when `contract` is present; `unknown` stubs render dashed + dim + "?" chip (three encodings, CVD-safe).

**Server:** `GET /api/apis[?scope=]` · `GET /api/apis/<id>` · `GET /api/apis/<id>/spec` (raw text, path-confined) · `GET /api/openapi?repo=<name>[&format=yaml]` (generated) · `POST /api/apis/diff` `{spec?: text, url?: string, path?: string, repo?: string}`.

**CLI:** `farsight api list` · `farsight api spec --repo <name> [--out openapi.yaml] [--format yaml|json]` · `farsight api diff --spec <path|url> [--repo <name>] [--format json|md] [--strict]` · `farsight ingest <url|spec.yaml> --repo <name>` (a spec as a source of its own).

**MCP:** `api_surface` (APIs in the graph with operation/consumer/drift counts; `api:` for one API's operation list) · `api_drift` (`spec` path/url optional — omitted means the stored ingest-time drift) · `api_spec` (generated spec for a repo, JSON, budgeted).

**Sources of a spec:** discovered in a repo by name (`openapi.*`, `swagger.*`, `**/openapi*.{yaml,yml,json}`, `docs/api*.yaml`) and content-sniffed (`openapi:` / `swagger:`); declared in `farsight.config.json → openapi: [{ path|url, name? }]`; a workspace source of `type: 'openapi'`; a CLI positional. OpenAPI 3.0/3.1 read in full; Swagger 2.0 read for paths/operations/parameters/security (`in: body` → requestBody). `$ref` resolved within the document; external refs kept as names.

## 5 · Honest states

- A route only in the spec renders with the `spec-only` chip and no source location — it is *declared*, not *implemented*, and the words say so.
- A code route in a repo that has a spec but is missing from it is `code-only` ("undocumented"). A repo with **no** spec gets no `code-only` stamps at all — absence of a spec is not a gap in every route, it is one fact about the API, shown once on the implied surface card.
- Cross-source consumer edges are `MEDIUM` confidence and say why (path-only match).
- Generated specs carry `x-farsight-inferred` on everything the graph could not see.
- Counts on the APIs surface carry their definition in a tooltip and the scope label next to them.

## 6 · Acceptance

1. `examples/invoice-app` gains `openapi.yaml` with deliberate drift: `DELETE /invoices/{id}` declared but not implemented, `POST /invoices/{id}/finalize` implemented but undocumented, `PATCH /invoices/{id}` declared with `billing:admin` while code enforces `billing:write`. After ingest all three appear as drift on the routes, in `farsight api diff`, in `api_drift`, and on `#/apis`.
2. `farsight api spec --repo invoice-app` → reconcile against the same graph → zero drift (round-trip test).
3. A journey from `GET /invoices` shows a Contract link on the route step; the Code map inspector for that route shows the contract and a ⧉ to the spec line.
4. A `fetch('/api/invoices')` in one source stitches to `GET /api/invoices` in another after `stitchHttp()` with `MEDIUM` confidence; an unmatched one is an `unknown` stub, never dropped.
5. `pnpm -r test` + `pnpm lint:strings` pass; every new string is in the catalog, every new glyph in the sprite.

## 7 · Out of scope (stated)

- Live endpoint probing / crawling a running API (D7).
- A `spec_drift` change kind in the frozen `farsight-diff v1` contract — drift is an ingest-time fact on the node today; carrying it into the diff is a v2 contract item.
- Request/response *schema* diffing beyond property names (types, nullability, enum changes) — the contract carries the schema names and top-level fields; deep schema diff is a follow-on.
- GraphQL / gRPC / AsyncAPI — same shape (declared contract ↔ implemented surface), different reader; the `contract` field and `reconcile` are written so a second reader is one file.
- Migrating the APIs surface counts to P3 metric objects (they carry definitions in tooltips until `core/metrics.ts` exists).

## 8 · Files

`core/src/graph.ts` (kinds + `OperationContract`) · `core/src/openapi.ts` (new: types, `specToFragment`, `reconcile`, `graphToSpec`, `apiSurface`, `consumersOf`, `toYamlish` is *not* here — YAML stays in parsers) · `core/src/stitch.ts` (new: `stitchHttp`) · `core/src/store.ts` (accessors) · `core/src/query.ts` (`businessSummary` rung) · `core/src/config.ts` (`openapi` block) · `core/src/strings.ts` (catalog) · `parsers/src/openapi/{read,discover,index}.ts` (new) · `parsers/src/index.ts` (post-pass + `ingestSpec`) · `parsers/src/tsjs.ts` (unknown/external stubs, resolution stamps on http edges) · `server/src/index.ts` (endpoints, openapi source type, stitch on sync) · `server/public/app/surfaces/apis.js` (new) · `shell.js` · `store.js` · `lib/graph-render.js` · `surfaces/journeys.js` · `viewer.html` (CSS + sprite `sym-api`) · `sym.js` · `cli/src/cli.ts` (`api` command, spec sources) · `mcp/src/run.ts` (3 tools + describe_node contract) · `examples/invoice-app/openapi.yaml` · `core/test/openapi.test.ts` · `parsers/test/openapi.test.ts` · docs (CLAUDE.md, ARCHITECTURE schema, ROADMAP, FEATURES, GETTING-STARTED).
