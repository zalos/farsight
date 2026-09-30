# Vision

## The problem

Understanding a real system today means reading code, tribal knowledge, and stale diagrams. Developers can navigate one repo at a time; business people can't navigate any of it. Nobody can answer "what actually happens when an invoice is created?" without an archaeology session — and the answer spans a frontend repo, a backend repo, and a database.

## The bet

If we parse everything into **one semantic graph** and make the **presentation layer configurable**, the same underlying truth can be shown to a developer as a call graph and to an analyst as a business process — and they can both point at the same node in a conversation.

The GUI borrows from game development because games solved this exact problem: presenting enormous, deeply nested worlds so that anyone can navigate them. Mini-maps, progressive zoom, quest logs, inventory filters, fast travel — these are navigation patterns for complexity, and they're the design language of Farsight.

## Personas

- **Dana (senior dev, billing team).** Wants: trace a request across services, find who calls what, spot dead code, onboard juniors faster. Cares about accuracy and jump-to-code.
- **Priya (product manager).** Wants: "show me the invoice process," see where validation rules live, know what a proposed change touches. Cares about plain language and not being lied to by stale docs.
- **Marcus (staff eng / architect).** Wants: the whole-system atlas, cross-repo dependency health, tagging domains to teams. Cares about multi-repo and evolution over time.
- **Ops/compliance.** Wants: every place auth is enforced (or missing) on a flow, visually called out.
- **Coding agents (Claude Code etc.).** Want: end-to-end feature context without grepping — "what is the invoice flow, what rules gate it, what breaks if I change this function." Farsight's MCP server answers these as structured tool calls over the same graph humans see. An agent briefed by `trace_flow` starts a change knowing every validation rule and auth gate on the path.

## Pillar features

### 1. Ask-for-a-flow ("show me the invoice process")
Natural-language or search-driven entry. Farsight resolves the query against tags, symbol names, docs, and route definitions, and renders the matching subgraph as a flow. A **lens toggle** switches the same flow between:
- **Business lens** — plain-language step names, swimlanes by system, validation/auth rules as badges;
- **Hybrid lens** — function names + docs, typed edges;
- **Code lens** — actual signatures, file paths, call/data edges.

Toggling lenses **never resets the viewport, selection, or expansion state** — that's the whole trick. It's the same graph; only labels, grouping, and level-of-detail change.

### 2. Deep links to the IDE
Every code-backed node carries `repo + path + line`. One click opens `vscode://file/...` (later: JetBrains, cursor, zed via URL-scheme adapters). Links are also shareable URLs into Farsight itself, encoding viewport + lens + filters, so "look at this" survives being pasted into Slack.

### 3. Cross-repo, cross-language flows
Ingest N repositories. Language adapters emit into the same graph schema; cross-repo edges are stitched from HTTP routes ↔ fetch calls, queue topics, shared schemas (OpenAPI, protobuf, SQL DDL), and explicit config. The invoice flow example: React components (create/update invoice UX) → API client calls → Express/Nest routes → services → ORM → tables, one continuous diagram with system boundaries drawn as regions.

### 4. Tagging & filtering
- Manual tags (right-click → tag), rule-based tags (`path:src/billing/** → invoice`), and inferred tags (symbols reachable from `POST /invoices`).
- Filters work like game inventory filters: chips for tags, systems, languages, node kinds; combinable; savable as named views.
- Overlays: heat by churn (git), test coverage, ownership (CODEOWNERS), auth-required.

### 5. Callouts for rules
Validation, authorization, feature flags, and error paths are detected (decorators, middleware, zod/joi schemas, guard clauses) and rendered as **badges on nodes and gates on edges** — visually distinct, expandable to see the actual rule and its source.

## Game-inspired UX vocabulary

| Game pattern | Farsight equivalent |
|---|---|
| World map / mini-map | System Atlas; persistent mini-map in flow views |
| Progressive zoom / LOD | Repo → module → function → code, streamed detail |
| Quest log | Saved traces & flows ("Invoice process", "Signup funnel") |
| Quest markers | Search results / trace steps highlighted in the world |
| Inventory filters | Tag/kind/system filter chips |
| Fast travel | Command palette (`⌘K`) jumps to any node/flow/view |
| Codex / bestiary | Entity pages: every symbol, route, table with docs & relationships |
| Fog of war | Unparsed / unindexed regions rendered dimmed |

## Configurability

- **Workspace config** (checked into the repo, `farsight.config.ts`): repos to ingest, language adapters, tag rules, lens vocabularies, glossary (`InvoiceService.finalize` → "Finalize invoice"), role presets.
- **Role presets**: which lens is default, which panels exist, how much code is visible. A "business" preset can hide code entirely; a "dev" preset opens in code lens.
- **Theming**: the game-HUD skin is default but everything is tokenized; a plain "enterprise" skin ships too.

## Non-goals (for now)

- Runtime tracing / APM (static analysis first; runtime overlay is a future integration).
- Editing code from the GUI.
- Being a diagramming tool — diagrams are *derived*, never hand-drawn, so they can't go stale.
