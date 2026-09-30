# Farsight — Feature Guide

*A shareable overview of what Farsight does today and what is being added in response to the July 2026 early-preview reviews. Written in the professional register — the product's own rule for anything that leaves the tool.*

**Last updated:** 2026-07-29 · **Status:** Phase 1 complete; V3 build underway — P1 (snapshot history + the frozen `farsight-diff v1` contract) and P2 (viewer shell: four surfaces, two registers, the Grammar Book) have landed
**Design file:** [Farsight — Design (Figma)](https://www.figma.com/design/VMHP6j8MpK9rVo3FJIL1bt) — V2 boards on page *04 · V2 — post-feedback*

---

## What Farsight is

Farsight reads a codebase and builds a **semantic graph** of what the software actually does — pages, routes, functions, permission gates, database records, messages, and the third-party packages woven through them. It then serves that one graph to three consumers:

- a **web viewer** for people (developers *and* business users, via switchable lenses),
- an **MCP server** so AI agents can query the same truth,
- a **CLI** for ingest, serving, and automation.

Two principles govern everything: **code is the source of truth** (annotations augment the graph, they never replace what parsing found; diagrams are derived, never hand-drawn), and **one graph, many lenses** (every surface is a view over the same schema — business users and engineers look at the same nodes with different words and ink).

Farsight is dogfooded on itself: this repository is one of its own indexed sources.

---

## Features available today

### Ingest & language adapters
- **Multi-source workspaces** — index any number of local or git repositories into one graph, with per-source exclude globs, collections (named groups of sources), and re-sync via API or viewer.
- **TypeScript / JavaScript adapter** — functions, React components, pages (React Router, Angular, and Next.js App Router conventions, including `'use server'` actions), Express and App Router routes, JSX render edges, calls-via-imports with monorepo alias and barrel-file resolution, zod validation rules, database reads/writes (Drizzle query builders and relational API, `pgTable` schemas → table nodes) with the query text attached, and fetch→route stitching so a client call links to the endpoint it hits.
- **Java / Spring Boot adapter** — request mappings → routes, method security → gates, `@Entity` → records with columns, Spring Data repositories → reads/writes with query text, Bean-Validation DTOs → rules, Kafka/Rabbit publish/consume edges, `@Scheduled` jobs and listeners as entry points, and dependency-injection call resolution. Built on a tree-sitter WASM substrate (no native dependencies) that future adapters reuse.
- **Documentation harvest** — vanilla JSDoc/TSDoc/Javadoc becomes part of the graph (summary sentences, `@deprecated`/`@see`/`@since`), and Farsight-specific tags add business meaning: `@business` (plain-language description, including on branch points and their arms), `@group`, `@tag`, `@guard`, `@entrypoint`. See `docs/ANNOTATIONS.md`.
- **Design source** *(new — 2026-09)* — a screens manifest (`docs/design/screens.json`: one row per designed screen with its route, Figma frame, optional image, the operations it uses) is discovered like a spec and reconciled against the pages and components the adapters found. Matched screens gain a `design` reference (*designed + built*), designed-but-unbuilt screens become pages with no source location (*designed, not built*), pages with no row are stamped *built, not designed*, and drift is computed once: operations the design lists that the page never reaches, operations no contract declares, operations the page calls that the design omits. Freshness comes from Figma's `lastModified` when `FIGMA_TOKEN` is set, else from the manifest. `@design <url|id>` on a page joins it by annotation. See `docs/proposals/design-source.md`.
- **Freshness metadata** — every graph knows when it was generated, from which files, and each surface leads with that fact.

### The viewer
- **Lenses** — one click switches between *business* (code hidden, plain names), *hybrid* (both names), and *code* views. The chrome itself changes register: amber for business, cyan for code, so you can feel which mode you are in.
- **Journey view** — pick an entry point (a route, a scheduled job, a listener) and see the end-to-end execution timeline: a flow map beside a scroll-synced code timeline with real code slices, fork markers with plain-language arm labels, and a forks drawer. In the business lens the map re-renders as a flowchart — permission gates as checkpoints, decisions as diamonds with labeled pathways — with the code pane hidden. A route that only a spec declares still journeys: its contract's security shows as a **planned gate** and its request payload, summary and 2xx payloads follow as **planned steps** (dashed, "declared in the spec — not yet built"), so a product can see its journeys before the first handler ships; `farsight diff` reports the **planned → built** transition when the handler lands.
- **Build identity** *(2026-09-06)* — `farsight --version` (also `version` / `-v`), the first lines of MCP `graph_overview` (*running:* and *graph ingested by:*), `GET /api/version`, and the HUD sync-chip tooltip all print the same facts: version · built (ISO time) · commit · packed / workspace. Every graph saved from now on carries `meta.farsight`, so a consumer can tell when the graph was last written and by which build. Workspace version is 0.1.0.
- **The blueprint timeline** *(2026-09-05, replaces the three-band blueprint)* — the journey overlay is one horizontal timeline: one **segment per screen** (a screen and everything the walk does until the next one), three lanes stacked in every segment — *What the user sees* (the screen as designed: thumbnail, design chip, ⧉ Figma / page / component / docs), a labelled line of visibility, *The business* (a flowchart in words: ▶ start, gates once per screen, the step, decisions with their pathways, ■ end), *What the system does* as **one row per system** the journey touches (the repo, each API by its spec title, records, messages, third parties) with every call / step / record / message a marker in its row under its screen, in execution order, dashed when declared and not built. A marker opens its contract (planned) or its spliced code (built) in place under its row; `j`/`k` walk the markers. **Linked journeys**: ◀ requires and leads to ▶ as slim end columns, *part of* chips in the header — declared in the manifest (`flows[].requires` / `leadsTo`) or derived from a longer flow's screen order. `journeySummary()` carries `segments` / `systems` / `links`; the MCP `journey` tool prints the same segments and rows. Design: `docs/proposals/blueprint-timeline.md` (option C of three Figma boards).
- **Screens on the journey** *(new — 2026-09)* — every journey opens with a SCREEN band: the derived page/component cards the walk starts from, each with its design reference — status in words, the docs' id, freshness — the screen's image (a repo file, or a Figma render fetched with `FIGMA_TOKEN` and cached) opening in a lightbox, and ⧉ *Open design* beside ⧉ VS Code. A designed-but-unbuilt screen runs as a journey too: the operations its design names become planned calls into the real routes, so a business reader walks screen → operation → gate → payloads before any UI exists. A **flow** (a feature: an ordered set of screens with its docs and operations) is a journey entry of its own — the timeline walks each screen in order, each continuing into its code or its planned calls, with the documents linked on the entry card. The Journeys tab lists each design source with its flows (*N of M screens built*, Run journey), designed / built / not-built counts, and a *Designed, not built* list as its front door.
- **Groups** — nodes group by declared `@group` tags or detected embedded components; groups render collapsed as single cards or expand in place.
- **Scope** — a grouped multi-select dropdown filters the whole viewer to any combination of sources; collections are checkable groups, and a selection can be saved as a new group.
- **Editor round trip** — every file:line reference in the viewer carries a ⧉ deep link that opens the exact line in VS Code.
- **Search (⌘K)**, focus mode, node context menus, guard badges, light and dark themes, and a settings surface for sources, collections, and defaults.
- **Model Hub panel** — a runtime overlay (separate from the semantic graph) showing local AI activity: registered models, recent events, liveness.
- **Four surfaces, one shell** *(new — V3 P2)* — Portfolio · Journeys · Code map · Changes in a hash-routed nav (deep links carry `@sync:N` and `?scope=`); role-based landing via a `defaultSurface` setting, where a shared link always overrides home. Surfaces that await their engine (Portfolio, Changes, Stewardship) say so honestly rather than rendering unprovenanced numbers.
- **Two registers** *(new — V3 P2)* — every user-facing string lives in a catalog with an HUD and a professional variant (`core/strings.ts`, served at `/api/strings`); a chrome toggle switches them, errors/permissions are register-invariant, and exports always use professional terms. The **Grammar Book** (`#/grammar`) renders every symbol and string from the same sprite and catalog the surfaces use — a symbol or phrase not on that page cannot render — and `pnpm lint:strings` enforces it.
- **APIs surface** *(new — 2026-09)* — a fifth tab (`#/apis`; HUD "Trade Routes") lists every HTTP API in scope: one card per OpenAPI/Swagger document found in a source (or declared in `farsight.config.json`, or added as a spec-only source by file or URL), plus an *implied* card for any source that serves routes with no spec on file. Each API page shows its operations by tag with the spec's own plain-language summaries, permission gates, consumer counts and status in words (*declared + implemented* · *not implemented* · *undocumented*), an operation panel (parameters · request body · responses · security · drift · consumers with the exact client call site and the screens upstream of it), the spec file itself with line numbers, and a READ-ONLY drawer that compares a pasted or URL-fetched proposed spec against the code. Journeys and the Code map link into it from every route that carries a contract, and back out to the source line and the spec line.
- **Drawn symbol grammar** *(new — V3 P2)* — a 25-symbol SVG sprite (12 business symbols + status glyphs, always glyph + word, never color alone) replaces all emoji in the chrome; a READ-ONLY chip and per-action consequence subtexts separate looking from doing; a published keymap (`?`) covers `b · j/k · f · ⌘K · y`.

### The MCP server (agent surface)
Agents get the same graph through tools rather than pixels:
- `graph_overview` — counts, kinds, entry points, freshness (with an explicit warning if the graph is empty or stale).
- `search_graph`, `describe_node` — find and inspect nodes by name/kind.
- `trace_flow`, `impact_of` — walk downstream/upstream: "what does this call?" and "what breaks if this changes?"
- `journey` — the same ordered execution timeline the viewer shows, with fork summaries; planned steps from a declared route's contract print as `⋯ (planned)` and are counted apart from built steps. Accepts a name, not just an id, plus `repo`/`group` filters (so do `search_graph`, `trace_flow`, `list_rules`).
- `list_rules` — validation and tag rules in force.
- `refresh_graph` — re-ingest the recorded sources in place.
- `api_surface`, `api_drift`, `api_spec` *(new — 2026-09)* — the API catalogue with consumers and drift; a proposed spec reconciled against the code; an OpenAPI 3.1 document generated from a repo's routes with every inference marked. `describe_node` on a route prints its contract.
- `design_surface`, `design_drift`, `design_guide` *(new — 2026-09)* — the design catalogue (flows with *N of M screens built*, screens with status, Figma link, image on file, operations, drift), a proposed manifest reconciled against the code, and the recipe for authoring a design-backed journey (manifest format with screens + flows, what is derived before code, how code joins the design, the verify loop). `describe_node` on a screen or flow prints its design block and doc links; `journey` takes a flow by name and walks the feature screen by screen.
- `model_hub_state` — the runtime AI overlay, summarized or raw.

### The CLI
One binary: `farsight ingest` (build the graph), `farsight serve` (viewer), `farsight mcp` (agent server over stdio). Packagable as an installable tarball.

*(new — V3 P1)* Every ingest/sync now also writes a **snapshot** (ordinal sync id, digest, commit, timezone) into `.farsight/farsight.db` — SQLite via the built-in `node:sqlite`, nothing native in the install path; on runtimes without the module the tool degrades honestly to latest-graph-only and says so. On top of that history:
- `farsight snapshots` — list (and `--pin`/`--prune`) the sync history.
- `farsight diff --from sync:N --to sync:M --format json|sarif|md` — a semantic change summary (routes/gates/records/messages/rules/journeys, per-change confidence, stable change ids) conforming to the **frozen `farsight-diff v1` contract** (`docs/contracts/farsight-diff-v1.md` + JSON Schema; content-hash fingerprints are declared PLANNED, not shipped).
- `farsight gate --policy compliance.yml` — facts live in the diff, judgment in a repo-owned policy file that sets the CI exit code.
- `--as-of sync:N` on `serve`/`mcp` — read the graph as it was at any retained sync.

*(new — 2026-09)* **OpenAPI in the graph.** A spec is documentation about HTTP endpoints, so its operations land on the same route nodes the code adapters find and gain a *contract*; the two are reconciled once at ingest and the disagreements (not implemented · undocumented · security mismatch · gate not declared · request body undeclared/unvalidated · deprecated in spec only) are stored on the route for every consumer to show identically.
- `farsight api list` — every API surface (spec-backed or implied) with operation / consumer / drift counts.
- `farsight api spec --repo <name> [--out openapi.yaml]` — an OpenAPI 3.1 document from the code: parameters from the path, request bodies from validation rules, security from gates, summaries from doc comments; `x-farsight-inferred` marks what the parser could not see, `x-farsight-source` links every operation to its line.
- `farsight api diff --spec <path|url> [--repo <name>] [--strict]` — a proposed spec against the code; `--strict` exits 1 on any drift (CI).
- `farsight ingest https://host/openapi.json --repo name` — a spec as a source of its own ("the API itself"). Unresolved `fetch()` calls are no longer dropped: they become `?` stubs that resolve to routes any other source declares, code or spec.

*(new — 2026-09)* **Designs in the graph.** A screens manifest is documentation about the UI, so its screens land on the same page/component nodes the adapters find and gain a *design* reference; reconciled once at ingest, drift stored on the screen.
- `farsight design list` — every design source with its screens: *designed + built* · *designed, not built* · *built, not designed*, the operations each screen uses, drift.
- `farsight design diff --manifest <path|url> [--repo <name>] [--strict]` — a proposed manifest against the code; `--strict` exits 1 on any drift (CI).
- `farsight ingest docs/design/screens.json --repo name` — a manifest as a source of its own (a design-only project: every screen designed, not built, every journey planned end to end).

---

## What we are adding — the feedback response

An eight-persona review of the concept boards (exec, transformation lead, business analyst, product owner, staff engineer, junior developer, SDET, QA lead) returned 7× TRIAL / 1× HESITANT. Every reviewer found real value; nobody found it ready. The findings attack **trust, language, exits, and missing states** — not the core model. Each item below names the finding it answers (F-numbers from `docs/proposals/feedback-response-plan-2026-07.md`).

### Trust: every number can defend itself
- **Provenance on every metric (F3).** Any percentage or count opens into a popover stating its formula, numerator/denominator, exclusions, as-of (sync + commit), origin mix (statically resolved / annotated / human-confirmed), and an uncertainty range when unknowns exist — with a one-click evidence list. Metrics become versioned definition objects, not decorated numbers.
- **Per-edge confidence (F9).** Edges carry a resolution status: *resolved* (solid ink), *heuristic* (dashed, with the technique and a confidence tier on hover), or *unresolved* — which renders as a first-class "?" stub listing candidates. "We don't know" is always drawn; absence always means absence.
- **Honest states (F5).** The four screens a rollout actually meets are designed as first-class states: minute one after ingest (machine-derived insight immediately, human context framed as the next step), staged ingest progress (unindexed regions clear as stages complete), failed sync (last-good snapshot with a red *failing* chip, visually distinct from amber *stale*), and question threads that age (unanswered questions escalate; recorded answers are marked suspect when the code changes under them).
- **Mock data is derived (F13).** A standing rule, now enforced: every number on a design board is derived from the real dogfood graph, the same way the product derives its own diagrams from code.

### Language: two registers, one meaning
- **Professional register (F2).** Every game-flavored term has a professional equivalent over one tokenized string catalog (fog of war → not yet indexed, quest → guided review, blast radius → change impact…). Per-workspace default, per-user toggle — and **exports always use professional terms**. Errors and permissions are register-invariant.
- **The Grammar Book (F6, F15).** One canonical rendering per concept across every surface: one STEP word (no hop/phase), one GATE shape, four distinct glyph+word chips for what was one ambiguous triangle (trend ↗ / warning ▲ / violation ⬣ / stale ◷), fog means unindexed only, no color-only meanings, and risk gets the brightest ink — never the dimmest.
- **Jargon budget (F7).** At most five unexplained terms per screen, enforced as a lint over the string catalog; first-use definition tooltips instead of tours.

### Exits: the graph is not a destination
- **Share and export everywhere (F1a).** Every view gets a share menu: a living link (always latest sync), a **pinned link** (`@sync:N` — exactly what you see now, forever), PNG/PDF export, and Confluence embed — every export carries a provenance footer (repo · commit · sync time · author).
- **Machine access (F1b).** `farsight diff --format json|sarif` emits a semantic change summary per PR/sync — routes added, gates removed, journeys reshaped — with stable IDs. Facts live in the diff; judgment lives in a repo-owned policy file that sets the CI exit code. This single feature moves our most audit-driven reviewer from hesitant to adopt, by her own statement.
- **Test ⇄ journey linkage (F11).** Declared (`@covers`) and graph-inferred links render as a coverage matrix where **gaps are drawn, not omitted**: journeys with zero tests, orphan tests verifying nothing, and links marked *suspect* when the journey they cover changes shape.

### Orientation: one product, many front doors
- **One product, one nav (F16).** The four concept boards are altitudes of one surface: **Portfolio** (the map), **Journeys** (the blueprint), **Dependencies** (the supply view), **Changes** (the ledger). One graph underneath; lenses change the words, never the data.
- **Role-based landing (F7).** Executives land on Portfolio, analysts and product owners on Journeys, developers on the code map — defaults, never cages; a shared deep link always overrides home.
- **Screen→code round trip (F4).** Already in the product (⧉ deep links); now guaranteed in the design language: every step, node, and diff line shows file:line in code/hybrid registers.
- **Change impact for one function (F10).** Select any symbol before editing it: who calls it, what it calls, records touched, messages emitted, journeys crossed — and the same data as one plain sentence for business users ("changing this affects invoice finalization, the accounting ledger, and the customer email").
- **Looking vs doing (F12).** A persistent read-only chip ("viewing changes nothing"), and every action button states its consequence in a subtext ("creates a checklist for you · does not touch code · no one is notified").

### Operations: who feeds the machine
- **Stewardship (F8).** Owners are auto-drafted from commit history and confirmed with one click; annotation debt becomes assignable, aging items; private completeness meters with a next-best-action — no public leaderboards.
- **Privacy line (F14).** Authorship data never aggregates per person — written policy, stated in the product. The authorship overlay answers "has anyone walked this code," never "who is behind."

### Delivery order *(amended after review round 2 — see `docs/proposals/v3-build-plan.md`; P1 + P2 of that plan landed 2026-07-29)*
1. **Phase 1 (viewer + strings + server):** string catalog and registers, share/export with pinned links, read-only chip and consequence subtexts, role-based landing, provenance popovers, Grammar Book applied, file:line everywhere.
2. **Phase 2 (schema + trust):** **contract first — the `farsight diff` JSON schema is frozen and versioned before any UI** (stable IDs + display names, truncation field, per-change confidence tier); then per-edge resolution and confidence, snapshots with as-of on every API, diff + policy gate, function change-impact panel, honest states wired into the viewer, **and the minimal stewardship debt queue (pulled forward from Phase 3 — round-2 condition for Marcus's ADOPT)**.
3. **Phase 3 (adoption loops):** the rest of stewardship (digests, completeness meters at scale), test⇄journey links and suspect propagation, question-thread lifecycle, compliance-grade evidence exports, jargon-budget lint in CI (interim: the Grammar Book is the manual lint fixture during Phases 1–2 — Tom's question).

---

## Design language, in one paragraph

Blue-black ground, condensed uppercase HUD labels, mono for code. Two meaning-bearing accents: **amber = business register, cyan = code register** — switching lens warms or cools the whole chrome. Node kinds keep fixed colors (components green, routes cyan, functions gold, records violet, gates purple). The game-derived *visual* system stays (it teaches); the *words* get a professional register (they travel). A light theme exists for bright rooms and print.

---

## Pointers

| Want… | Go to |
|---|---|
| Why Farsight exists, personas | `docs/VISION.md` |
| Architecture and ADRs | `docs/ARCHITECTURE.md` |
| What's done / what's next | `docs/ROADMAP.md` |
| Walkthrough for new users | `docs/GETTING-STARTED.md` |
| Annotation reference | `docs/ANNOTATIONS.md` |
| Finding-by-finding response plan (F1–F16 + round-2 G1–G20) | `docs/proposals/feedback-response-plan-2026-07.md` |
| V2 design boards | Figma, page *04 · V2 — post-feedback* |
| V3 design boards (round-2 response) | Figma, page *05 · V3 — the reprint* |
