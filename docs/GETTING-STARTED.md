# Getting Started

Farsight parses your codebase into a semantic graph, then lets you explore it three ways: a visual HUD in the browser, structured MCP tools for AI agents, and (soon) a full canvas GUI.

## Install

**From a release (no checkout needed):** each [GitHub Release](https://github.com/zalos/farsight/releases) notes the
install line, e.g. `npm install -g https://github.com/zalos/farsight/releases/download/vX.Y.Z/farsight-cli-X.Y.Z.tgz`,
then `farsight --version` names the version and commit. See [RELEASING.md](RELEASING.md).

**Option A — build the installable (recommended for trying it out):**

```sh
git clone <this-repo> && cd farsight
pnpm install && pnpm build
node scripts/pack.mjs
npm install -g ./build/farsight-cli-*.tgz
```

You now have a global `farsight` command. (Publishing to the npm registry as `farsight-cli` is planned — then this becomes `npm install -g farsight-cli`.)

Keep the `./` prefix (or use an absolute path): a bare `build/...` argument that doesn't resolve from your cwd is parsed by npm as a GitHub `user/repo` shorthand and dies with a confusing SSH error.

**Option B — run from the workspace (for hacking on Farsight):**

```sh
pnpm install && pnpm build
alias farsight="node $PWD/packages/cli/dist/cli.js"
```

Requirements: Node ≥ 22 to build the workspace (≥ 20 to run the packed CLI). No other toolchain — the fast parsing comes from oxc's prebuilt native bindings.

Not on any package registry yet — to use Farsight from *another* project on this machine, see [Using Farsight in another app](#using-farsight-in-another-app-local-only-no-registry-yet) below.

## 1. Parse a repo

```sh
cd your-project
farsight ingest .                 # writes graph.json
farsight ingest ../repo-a ../repo-b --out graph.json   # multiple repos into one graph
```

You'll get a summary like `89 nodes, 114 edges · function:48 page:3 route:5 …` in tens of milliseconds. What the TS/JS adapter extracts today: functions, React components, **application routes/pages** (React Router `createBrowserRouter`/`<Route>` and Angular-style `{path, component}` arrays), **component render trees** (`renders` edges from JSX usage), call edges, Express-style routes, auth middleware (guards), zod schemas (rules), `db.table` reads/writes, published events, and client `fetch` calls stitched to the routes they hit.

**Java works too** — the same command on a Spring Boot codebase yields the same graph language: `@GetMapping`-family annotations become routes (class-level `@RequestMapping` base included), `@PreAuthorize`/`@Secured` become guards, JPA `@Entity` classes become tables with their columns, Spring Data repositories yield `reads`/`writes` edges carrying the JPQL or derived-query text, Bean-Validation DTOs become rules wired to the handlers that take them `@Valid`, Kafka/Rabbit templates and listeners become queues, and `@Scheduled` jobs are entry points. Javadoc is harvested exactly like JSDoc — try it on `examples/spring-invoice-api`, the annotated Java twin of the invoice app.

## 2. Explore it visually

```sh
farsight serve            # http://localhost:4477
```

- **⌘K** — search everything; Enter focuses the graph on that node's neighborhood ("focus mode"; Esc exits).
- **Business / Hybrid / Code** — the lens toggle. Hybrid shows both the plain-language name and the code name on every node; Business hides code entirely; Code leads with symbols and source. Selection survives switching.
- **Click a node** — the inspector reads top-down: business summary, docs, rules & gates, data access (with the actual query code), then **Source (truth)** — the real implementation snippet. **Open in VS Code** jumps to the exact `file:line`.
- **Guards ride their nodes** — auth scopes appear as 🔒 badges on the route they protect, validation as ⛨ badges.
- **Groups** — files with several functions collapse into one group node ("Invoice service · 6 members"). ⊕ (or double-click) expands the group **in place**: members render inside a dashed container that keeps its position, so you dive in and back out without losing the map. Authors can override grouping with JSDoc `@group`.
- **Embedded components auto-collapse** — a component rendered by exactly one parent tucks into an expandable "· embedded" container under that parent (transitively — deep component trees stay one tidy box until you dive in). The UI lane reads top-down: pages (app routes) → screens → embedded pieces, continuing into API routes, logic, and data for a clean end-to-end view.
- **Right-click any node** — Focus here, Inspect, Open in VS Code, Expand/Collapse group, Copy node id. The inspector has matching Focus / VS Code action buttons.
- **Scope selector** — view all sources, one source, or a named collection ("Invoice systems").
- **⚙ Settings** — manage sources (local folders or git URLs — cloned/pulled into `.farsight/cache`), per-source **exclude globs** (e.g. `examples/**`, `**/*.test.ts` — keeps a vendored sample app out of the parent repo's graph), build collections, switch dark/light theme, set the default lens, and **Sync & re-ingest** without leaving the browser. Persists to `.farsight/settings.json`, which is local and not committed — start from `cp .farsight/settings.example.json .farsight/settings.json` (it lists this repo, the two example apps, and one example Jira and Azure DevOps source, both disabled), or from nothing: without the file the workspace is one local source. The CLI takes the same exclusions: `farsight ingest . --exclude "examples/**,**/*.test.ts"`.

## 2½. Augment the graph from your docs

Code is the source of truth; doc comments augment it — and **ordinary doc comments already work**: the summary sentence of a plain JSDoc/TSDoc/Javadoc comment becomes the business-lens description when no `@business` tag is present, and standard tags (`@deprecated`, `@remarks`, `@see`, `@since`, TSDoc's `@beta`/`@internal`…) flow into the graph too, with `{@link}`/`{@code}` markup stripped to readable text. The Farsight tags below add what no vanilla tag can say (the same spelling works in JSDoc, TSDoc via `tsdoc.json`, and Javadoc via `-tag` — see [ANNOTATIONS.md](ANNOTATIONS.md) for the full matrix and plug-n-play snippets):

```ts
/**
 * Finalizes a draft: completeness check, sequential number, ledger entry.
 * @business When an invoice is sent, we verify it is complete, assign the
 * next official number, record it in the ledger, and email the customer.
 * @group Invoice lifecycle
 * @tag billing, compliance
 */
export async function finalizeInvoice(id: string) { … }
```

- `@business` — plain-language summary shown in the Business lens and inspector.
- `@group` — logical grouping in the graph (overrides file-based grouping).
- `@tag` / `@tags` — custom tags for filtering and search.
- `@guard [label]` — declares an auth/permission wrapper (`withTenant(clientId, fn)`…): the function becomes a guard node (🔒) and every caller gets a `guards` edge, even before an adapter understands the framework.
- `@entrypoint [kind:name]` — declares an entry point no route detector can see (cron/queue jobs): `@entrypoint job:weekly-consolidation` makes the function searchable by those terms and lists it under `graph_overview` entry points, so `trace_flow("weekly consolidation")` seeds from it.

Forks (the `if`/`switch`/`catch` decisions a Journey narrates) can carry business labels too — doc comments can't attach to statements in any ecosystem, so a plain comment reuses the same tag next to the branch:

```ts
// @business High-severity recalls skip the review queue
if (recall.severity >= 8) {
  escalate(recall);
} else { // @business Routine recalls wait for weekly review
  enqueue(recall);
}
```

The label shows in the Journey's fork markers, Forks drawer, and MCP `[when …]` hop markers — plain language in the Business lens, alongside the raw condition in Hybrid. Placement rules and per-ecosystem setup (tsdoc.json, eslint-plugin-jsdoc, javadoc `-tag`) live in [ANNOTATIONS.md](ANNOTATIONS.md).

Both are also declarable in `farsight.config.json` for code you'd rather not annotate — matchers work like tag rules (case-insensitive substring on path or name). A guard matcher shaped like a route (`METHOD /path`) declares a gate on that route instead — for capability URLs an OpenAPI spec cannot express (`/track/{token}`): the route shows the 🔒, and `api drift` reports `security-declared-only` once a handler exists that enforces nothing the parser can see:

```json
{
  "guards": { "tenant-isolation": ["withTenant"], "tracking token": ["GET /api/v1/track/{token}"] },
  "entrypoints": { "job": ["jobs/"] }
}
```

The config is applied by `ingestRepo()` itself, so the CLI, the server sync and the MCP `refresh_graph` all see the same graph.

## 3. Feed it to your AI agent (MCP)

Add to your project's `.mcp.json` (Claude Code picks it up on session start):

```json
{
  "mcpServers": {
    "farsight": {
      "command": "farsight",
      "args": ["mcp", "--graph", "graph.json"]
    }
  }
}
```

Or register it with the Claude Code CLI instead of editing the file by hand:

```sh
claude mcp add farsight -- farsight mcp --graph graph.json
```

Notes on how this runs:

- The MCP server speaks **stdio** — Claude Code (or any MCP client) launches the command itself; you never run `farsight mcp` in a terminal yourself.
- The client launches it with the **project root as cwd**, so the relative `graph.json` path resolves to the snapshot at your repo root.
- `graph.json` must exist before the server starts — run `farsight ingest` first (it's a build artifact; typically gitignored, so fresh checkouts re-ingest).
- The graph path can also come from a `FARSIGHT_GRAPH` env var instead of `--graph` (useful when the MCP client config takes env more readily than args).
- Config changes are picked up at **session start** — restart the session (or use `/mcp` in Claude Code) after adding the entry.

The agent gets six tools: `graph_overview`, `search_graph`, `describe_node`, `trace_flow`, `list_rules`, `impact_of`. A typical agent opening move on a task like "add a discount field to invoices":

```
trace_flow("invoice process")   → the full UI→API→service→DB flow, rules called out
list_rules("invoice")           → every zod schema + auth scope with file:line
impact_of("createInvoice")      → what breaks if the signature changes
```

### Setup script for an LLM agent

If you *are* an agent setting Farsight up in a project (assuming `farsight` is installed — see the next section if it isn't), the whole setup is:

```sh
# 1. sanity: node ≥ 20 and the CLI resolves
node --version && farsight ingest --help 2>&1 | head -1

# 2. parse the repo into a graph snapshot at the project root
farsight ingest . --repo my-app        # add --exclude "dist/**,**/*.test.ts" as needed

# 3. verify the snapshot exists and is non-trivial
node -e "const g=require('./graph.json'); console.log(g.nodes.length,'nodes,',g.edges.length,'edges')"

# 4. wire up MCP (skip if .mcp.json already has a farsight entry — merge, don't overwrite)
cat > .mcp.json <<'EOF'
{
  "mcpServers": {
    "farsight": {
      "command": "farsight",
      "args": ["mcp", "--graph", "graph.json"]
    }
  }
}
EOF
```

Then tell the user to restart their session so the client spawns the server. On your next turn, start with `graph_overview` to orient, `search_graph` to find entry points, and `trace_flow`/`impact_of` before editing anything. Re-run `farsight ingest` after significant code changes — the graph is a snapshot, not live.

## 4. Configure (optional)

Drop a `farsight.config.json` at the repo root — applied automatically during ingest:

```json
{
  "tags": {
    "billing": ["src/billing", "invoice"],
    "auth": ["src/auth", "requireScope"]
  },
  "glossary": {
    "finalizeInvoice": { "label": "Finalize & send invoice",
                         "description": "Locks the invoice and emails the customer." }
  }
}
```

- **tags**: tag → substring matchers against each node's path/name. Tags drive the filter chips, search, and MCP queries.
- **glossary**: symbol name → business-lens label. Without an entry, the Business lens auto-derives one (`finalizeInvoice` → "Finalize invoice"). Class members are named `Class.method`, and an entry matches them in this order: the exact name (`"BcClient.request"`), then the member part (`"claimNext"` labels `PgBcOutboxRepository.claimNext` and every other `*.claimNext`), then the class part — `"BcClient"` labels each `BcClient.*` member without an entry of its own as the class's words plus the member, humanized (*Business Central client: create vendor*), and its description stays on the class. A class has no node of its own, so a class entry is only ever seen through its members.
- **tooling**: globs of scripts a person runs by hand — not the running app. Default `["scripts/**"]` (repo-relative, top level); `[]` turns it off, and naming globs replaces the default (`["scripts/**", "tools/**"]`). Their nodes are tagged `tooling`; a call from the app into one (a hook bound at `new Worker({ log })` in a script, a shared name) is kept in the graph at LOW confidence with a note, and a journey that starts in the app never walks into it. A journey that starts in a script walks as it always did.
- **plumbing** / **setup**: globs of helper directories that fold into their caller in journeys (`["libs/api/http/**"]`), and the node ids of the functions that build the process container (named once as the boot, never walked under every request).
- **openapi**: `[{ "path": "docs/api.yaml" }, { "url": "http://localhost:3000/openapi.json", "name": "Billing API" }]` — spec documents to reconcile against this repo's routes beyond the ones discovery finds by name (`openapi.*`, `swagger.*`, `api*.yaml`, anything under `openapi/`).

**An NX or workspaces monorepo.** Ingest reads the workspace's projects on its own: with `nx.json` at the source
root, every `project.json` (its `name`, `projectType`, `tags`, `implicitDependencies`) and every `package.json` that
carries an `nx` key or sits in a root `workspaces` glob; without NX, one project per workspace package; without
either, the source itself is one project. Every node under a project folder carries its project, type and tags
(MCP `describe_node` prints them), and `GET /api/projects` (or MCP `graph_overview`'s `projects:` line) lists the
projects with the dependencies between them — read from the imports between their files, plus NX
`implicitDependencies`. Tags group by dimension: `scope:` is *Domain*, `type:` is *Type*, `platform:` is *Platform*;
rename or add dimensions and give tag values their words in `farsight.config.json`:

```json
{ "projects": { "tagDimensions": [ { "key": "team", "prefix": "team:", "label": "Team" } ],
                "tagValues": { "type": { "feature": "Feature", "ui": "UI", "util": "Utility", "data-access": "Data access" } } } }
```

`examples/nx-workspace` is a small NX workspace to try it on.

## 5. APIs: spec ↔ code

If a source ships an OpenAPI/Swagger document, ingest reconciles it with the routes it found. The **APIs** tab in the viewer (`#/apis`) lists every API — spec-backed, or *implied* when a source serves routes with no spec on file — with operations, gates, consumers (the client function and its call site), and drift in words: *not implemented*, *undocumented*, *security mismatch*, *gate not declared in spec*, *request body not declared / not validated*, *deprecated in spec only*. Every route that carries a contract links there from Journeys and the Code map inspector, and back out to the source line and the spec line.

```sh
farsight api list                                  # every API surface with counts
farsight api spec --repo invoice-app --out openapi.yaml   # generate a spec from the code (inferences marked)
farsight api diff --spec proposed.yaml --repo invoice-app --strict   # proposed spec vs code; exit 1 on drift
farsight ingest https://petstore3.swagger.io/api/v3/openapi.json --repo petstore   # a spec as a source of its own
```

`examples/invoice-app/openapi.yaml` carries deliberate drift (a declared-only `DELETE`, an undocumented `finalize`, a scope mismatch on `PATCH`) so you can see each state.

## 6. Designs: screens ↔ code

The point of Farsight is business and developers walking the **same** journey — screens the business recognises, the code and API calls and rules behind them. Add a screens manifest at `docs/design/screens.json` (or declare it in `farsight.config.json → design`) and ingest reconciles it against the pages and components it found:

```json
{
  "name": "Acme — Phase 1 screens",
  "figma": { "file": "https://www.figma.com/design/EXAMPLEFILEKEY0000000", "token": "env:FIGMA_TOKEN" },
  "screens": [
    { "id": "SCR-07", "name": "Quick submit", "route": "/submit",
      "url": "https://www.figma.com/design/EXAMPLEFILEKEY0000000?node-id=26-9",
      "image": "docs/design/scr-07.png",
      "operations": ["lookupContractorByVendorId", "createSubmission"], "phase": "1",
      "description": "No login: vendor lookup, upload with OCR confirm, submit." }
  ]
}
```

- `route` is the screen's identity, spelled any way (`/track/[token]`, `/track/{token}`, `/track/:token`); use `component` for a screen that is not a page.
- `operations` are the operationIds the design says the screen uses — checked against the API contracts and, once the page is built, against what it actually reaches.
- `image` is a repo-relative PNG/JPG/SVG/WebP; with `FIGMA_TOKEN` set, a screen with a Figma node gets its frame rendered and cached under `.farsight/cache/design/` (and its freshness from Figma). Without a token the deep link still works.

Every journey then opens with its **screens** (image, design status, ⧉ Open design), the Journeys tab lists each design with *designed / built / not built* counts, and a designed-but-unbuilt screen already runs as a journey: its operations become planned calls into the real routes. `@design SCR-07` (or a Figma URL) on a page joins it by annotation when the route in code differs from the manifest.

Check what you are talking to first: `farsight --version` prints `farsight 0.1.0 · built <ISO time> · commit <sha> · packed`; the MCP `graph_overview` tool and `GET /api/version` print the same, plus which build wrote the graph.

The journey overlay is the **blueprint timeline**: one column per screen, and inside it what the user sees, the business flow, and one row per system the journey touches (the app, each API, records, messages, third parties) — a marker opens its contract or code in place. A second **view** of the same journey, the **sheet** (`TIMELINE · SHEET` in the header, key `v`, `?view=sheet`), turns it into actions across and layers down — what the user sees · app parts · the API call · server parts · gates & business · records · messages · third party · verified by — with at most two chips per cell; lens, view and the `rows | ladder` band are independent. A third view, the **drill** (`DRILL`, `?view=drill`), is an experiment switched on per workspace under Settings → *Experiments*: the journey's actions as stops on a rail, one action opened into its beats in causal order — the screen, the browser, the seam, the server parts, the answer the contract declares — with an arrow from each beat to the next and an inspector on the right (docs, request / response, code, forks, tests) for whichever box you click. Where a marker's contract or code opens is a fourth, independent choice — `IN PLACE · BOTTOM · RIGHT` in the header (key `d`, `?dock=`): in place means under the row that owns the marker; bottom or right pins a pane to that edge of the journey so the code stays in view while the timeline scrolls, and the pane's edge drags to resize. The walk is honest about its edges: `n cut points` says where it stopped following a subtree, each system row draws only the high-level parts of a call (the handler or the browser action and what they call directly) and folds everything deeper under its part as `▸ n inside` — a drill-down one level per click, plumbing marked as `▸ n helpers` — while a marker's expansion still shows the whole spliced code flow, and the business lens draws only decisions someone labelled with `@business`, counting the rest as *conditions not translated*. Flows link up: `flows[].requires` / `flows[].leadsTo` name the journeys before and after this one, and Farsight derives the same links when a longer flow lists your screens in order (◀ requires · leads to ▶ · part of, on the timeline and in the MCP `journey` print).

### A feature as one journey: flows

A feature the business names — *vendor (contractor) validation* — spans several screens. Declare it as a **flow**: an ordered list of screen ids, the documents that describe it, the operations it spans. A flow becomes an entry point (`flow` node) whose journey walks each screen in order, and each screen continues into its own code (built) or planned calls (designed only) — so the timeline reads screen → component → client call → route → gate → record, screen by screen, with the docs linked on the entry card:

```json
{
  "screens": [
    { "id": "SCR-06", "name": "Find your vendor record", "route": "/validate", "url": "https://www.figma.com/design/EXAMPLEFILEKEY0000000?node-id=24-2", "operations": ["lookupContractorByVendorId"] },
    { "id": "SCR-07", "name": "Confirm identity signals", "route": "/validate/confirm", "url": "https://www.figma.com/design/EXAMPLEFILEKEY0000000?node-id=26-9", "operations": ["verifyContractor"] },
    { "id": "SCR-08", "name": "Validated — continue to submit", "route": "/submit", "url": "https://www.figma.com/design/EXAMPLEFILEKEY0000000?node-id=30-1", "operations": ["createSubmission"] }
  ],
  "flows": [
    { "id": "contractor-validation", "name": "Vendor (contractor) validation",
      "description": "A contractor proves who they are before an invoice can be submitted.",
      "screens": ["SCR-06", "SCR-07", "SCR-08"],
      "docs": ["docs/product/vendor-validation.md", "docs/decisions/0021-contractor-email-sessions-swappable-store.md"],
      "operations": ["lookupContractorByVendorId", "verifyContractor", "createSubmission"], "phase": "1" }
  ]
}
```

Then, before any page exists: `farsight design list` shows the flow as *0 of 3 built*; the HUD's Journeys tab → **Designs** → the flow → *Run journey* walks SCR-06 ⋯ `lookupContractorByVendorId` → planned gate → planned steps, SCR-07 ⋯ `verifyContractor` …, SCR-08 ⋯ `createSubmission` …; the MCP `journey` tool takes the flow by name (`entry: "Vendor (contractor) validation"`). As pages land at `/validate`, `/validate/confirm`, `/submit`, the same journey grows real steps, the counts move to *3 of 3 built*, and `farsight diff` reports each operation's *planned → built*. The full recipe — manifest format, what is derived before code, how to write the code so it joins the design, the verify loop — is one call away for an agent: the MCP `design_guide` tool, or `GET /api/design/guide`.

```sh
farsight design list                                       # every design source with its screens and status
farsight design diff --manifest docs/design/screens.json --repo example-app --strict   # proposed manifest vs code; exit 1 on drift
farsight ingest docs/design/screens.json --repo example-app-design   # a manifest as a source of its own (no code yet)
```

### Who a journey is for, in groups, in your order

Journeys are shown persona → group → journeys — on the Journeys front door, the Portfolio, the Map, `GET /api/journeys`, the MCP `journeys` tool and `farsight journeys` — in the order the manifest declares. Add `personas[]` and `groups[]` to the manifest and name them on each flow:

```json
{
  "personas": [
    { "id": "contractor", "name": "Contractor", "description": "A vendor who submits and tracks invoices." },
    { "id": "ops", "name": "Operations", "description": "The team that verifies vendors and approves invoices." }
  ],
  "groups": [
    { "id": "access", "name": "Access", "description": "Ways in and out." },
    { "id": "vendor-accounts", "name": "Vendor accounts", "persona": "contractor" },
    { "id": "invoices", "name": "Invoices" }
  ],
  "flows": [
    { "id": "contractor-sign-in", "name": "Sign in with email", "persona": "contractor", "group": "access", "order": 1, "screens": ["CON-01"] },
    { "id": "vendor-account-creation", "name": "Create a vendor account", "persona": ["contractor", "ops"], "group": "vendor-accounts", "screens": ["CON-03", "OPS-04"] }
  ]
}
```

- `personas[]` and `groups[]` are shown in the order written. A group with `persona` exists under that persona only; one without, under every persona that has a journey in it.
- `flows[].persona` is an id or name, or a list — a journey for two kinds of person is listed under each and counted once. A value nothing declares is a persona of its own after the declared ones (so the single string `"Contractor and Operations"` is a third persona: write `["contractor", "ops"]`); no persona falls back to the shared screen-id prefix (*derived*), else *Not grouped*.
- `flows[].group` is an id or name; none puts the journey in the persona's trailing *Other journeys*. `flows[].order` sorts inside the group; without it, the order the flows are written in — never alphabetical. The persona's *start here* is computed, not declared.
- `owner` (who answers for a flow), `work` (the work-item keys a flow or screen is for) and `surfaces[]` (the product surfaces the docs scope, drawn or not) sit beside them.

`farsight.config.json → journeys` takes the same shapes and organises across manifests without editing them: its arrays are the order, an entry overrides the manifest entry with the same id field by field, and `flows[]` places a flow a manifest declared (`{ "id": "vendor-account-creation", "group": "access", "order": 3 }`) — an id no manifest declares is a note, never a journey. In an NX workspace each app can keep its own `apps/<app>/docs/design/screens.json` (discovered by name) and its own `apps/<app>/farsight.config.json`, whose paths are relative to the app's folder and whose `journeys` block applies to the manifests under it; `projects` and `tooling` are read from the root file only. Farsight never writes these files: an agent edits them with its own tools, calls `refresh_graph`, and checks the result with `journeys` (`design_guide` carries the whole schema).

```sh
farsight journeys                       # persona › group › journeys, with status, screens built and the way in
farsight journeys --persona ops --json  # one persona, as the JourneyTree document GET /api/journeys returns
```

`examples/invoice-app/docs/design/screens.json` is the dogfood fixture: two built screens (one with an SVG wireframe), one designed-but-unbuilt screen listing `deleteInvoice`, one page with no design row, one operation the design lists that its page never reaches; two personas (*Billing*, *Operations*), two groups, one journey under both personas, and a `journeys` placement in its `farsight.config.json`. `examples/nx-workspace` keeps one manifest per app (`apps/billing-web/…`, `apps/ops-admin/…`, each with an *Access* group) beside the root one.

## Using Farsight in another app (local-only, no registry yet)

Until `farsight-cli` is published to npm, every consuming app installs from this checkout. Three ways, in order of preference:

### Option A — global install from the tarball (recommended)

Build once here, use everywhere:

```sh
cd /path/to/farsight
pnpm install && pnpm build
node scripts/pack.mjs                          # → build/farsight-cli-*.tgz
npm install -g ./build/farsight-cli-*.tgz
```

Then in any app:

```sh
cd /path/to/other-app
farsight ingest . --repo other-app
farsight serve                                 # HUD on :4477
```

…and its `.mcp.json` just says `"command": "farsight"` (exactly as in section 3). This is the cleanest option because the config is machine-portable — nothing in the consuming repo references where the Farsight checkout lives.

### Option B — per-project dev dependency (pinned per app)

If you'd rather not pollute the global bin, install the tarball into the app:

```sh
cd /path/to/other-app
npm install --save-dev /path/to/farsight/build/farsight-cli-*.tgz
npx farsight ingest . --repo other-app
```

MCP config then goes through `npx`:

```json
{
  "mcpServers": {
    "farsight": {
      "command": "npx",
      "args": ["farsight", "mcp", "--graph", "graph.json"]
    }
  }
}
```

Caveat: npm records the tarball path in `package.json` (`file:../farsight/build/...`), so teammates without this checkout can't `npm install` — fine for a solo machine, awkward for a shared repo. Prefer Option A for shared repos until we publish.

### Option C — zero install: point back at the workspace

No pack step at all — run the workspace build directly:

```sh
alias farsight="node /path/to/farsight/packages/cli/dist/cli.js"
```

```json
{
  "mcpServers": {
    "farsight": {
      "command": "node",
      "args": ["/path/to/farsight/packages/cli/dist/cli.js", "mcp", "--graph", "graph.json"]
    }
  }
}
```

⚠️ Point at `packages/cli/dist/cli.js`, **not** `build/farsight-cli/dist/farsight.mjs`. The packed bundle keeps `oxc-parser`, the MCP SDK, and `zod` external — they only resolve after `npm install` lays down the package's own `node_modules`. Inside the workspace, `packages/cli` resolves them through pnpm's symlinks; the raw `build/` output resolves nothing.

Best while actively hacking on Farsight itself: `pnpm build` and every consumer is instantly on the new code. Worst for portability: the absolute path is machine-specific, so keep it out of committed `.mcp.json` files (use `claude mcp add --scope local`, or `.mcp.local.json` if your client supports it).

### Refreshing after Farsight changes

| Install | To pick up new Farsight code |
|---|---|
| A (global tarball) | `pnpm build && node scripts/pack.mjs && npm i -g build/farsight-cli-*.tgz` |
| B (per-project tarball) | rebuild + repack as above, then re-run `npm install` of the tarball in each app |
| C (workspace path) | `pnpm build` — that's it |

Two gotchas:

- **Same-version tarball reinstalls can be served stale from npm's cache.** If a reinstall doesn't pick up changes, add `--force`, or bump `version` in the root `package.json` (pack.mjs stamps the tarball from it).
- **Running servers hold old code.** Restart `farsight serve` and restart any MCP client session after upgrading — and re-run `farsight ingest` in the consuming app if the parser changed, since `graph.json` is a snapshot of what the *old* parser extracted.

## Dogfood: Farsight on Farsight

This repo eats its own cooking:

```sh
farsight ingest . --repo farsight && farsight serve
```

…then ⌘K → "ingestTsJs" to see the parser's own call graph, or start a Claude Code session here (`.mcp.json` is already set up) and ask it to `trace_flow("ingest")`.

Farsight's own e2e suite shows up the same way a product's would: `pnpm build && pnpm e2e` drives the real viewer and MCP server against a fixture graph and writes `e2e/test-results/results.json`, which this repo's `farsight.config.json → tests.e2e` reads — after the next ingest or sync the Tests tab lists the specs as e2e tests with their last run and freshness, and each links to the viewer functions and routes it `@covers`.

## Troubleshooting

- **`no graph at graph.json`** — run `farsight ingest` first; `serve` and `mcp` read the snapshot it writes.
- **VS Code button does nothing** — deep links use the absolute path recorded at ingest time (`roots` in graph.json); re-ingest on the machine where you browse.
- **A repo parses to 0 nodes** — only `.ts/.tsx/.js/.jsx/.mjs/.cjs` and `.java` are read today; Rust/C#/Kotlin/Python adapters are on the roadmap (Phase 3).
- **`Cannot find package 'oxc-parser'` when running the bundle** — you invoked `build/farsight-cli/dist/farsight.mjs` directly. Native/SDK deps are external in the bundle; install the tarball (Options A/B) or run `packages/cli/dist/cli.js` from the workspace (Option C).
- **The MCP server doesn't show up in the agent session** — MCP config is read at session start; restart the session (or `/mcp` in Claude Code). Also confirm `graph.json` exists at the project root — the server exits if the snapshot is missing.
- **Reinstalled the tarball but behavior didn't change** — same-version reinstalls can hit npm's cache; `npm i -g --force build/farsight-cli-*.tgz` or bump the root `package.json` version before repacking. Then restart `serve`/MCP sessions.
