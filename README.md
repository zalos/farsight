# Farsight

[![CI](https://github.com/zalos/farsight/actions/workflows/ci.yml/badge.svg)](https://github.com/zalos/farsight/actions/workflows/ci.yml)

**See your software the way you think about it.**

Farsight is a code-intelligence platform that parses your codebases (AST + semantic analysis), builds a unified knowledge graph, and renders it through a video-game-inspired GUI. Ask it *"show me the invoice process"* and get an explorable visual of that flow — then toggle between business-friendly and code-level views without losing your place, follow the flow across repos and languages, and deep-link any node straight into your IDE.

## Who it's for

| Audience | What they get |
|---|---|
| **Developers** | Call graphs, module maps, cross-repo traces, jump-to-code (VS Code first) |
| **Business / Product** | Plain-language process flows, validation & auth rules called out visually, feature tracking across systems |
| **Teams** | A shared, tagged, filterable map of the system that both sides can point at |

## Core ideas

1. **One graph, many lenses.** Parsing produces a language-agnostic Semantic Graph. Every visual — business flow, call graph, system atlas — is a *lens* over the same graph, so switching views preserves your position and selection.
2. **Progressive zoom, like a game map.** World (all repos) → Region (service/repo) → District (module) → Street (function/handler) → Interior (code). Zoom is continuous; detail streams in.
3. **Tags are first-class.** Anything (node, edge, subgraph) can be tagged — `invoice`, `auth`, `deprecated`, `team:billing` — manually or by rules. Filters, overlays, and searches all run on tags.
4. **Configurable for the audience.** Workspaces define which lenses, labels, and vocabularies each role sees. The same node is `InvoiceService.finalize()` to a dev and "Finalize invoice" to an analyst.
5. **Multi-repo, multi-language.** Language adapters (TypeScript/JavaScript first; Rust, Java, C# next) all emit the same graph schema, so one flow can span a React frontend, a Node API, and a database.

## Install a release

Every [GitHub Release](https://github.com/zalos/farsight/releases) carries the installable CLI. Copy the line from
its notes — for a release `vX.Y.Z`:

```sh
npm install -g https://github.com/zalos/farsight/releases/download/vX.Y.Z/farsight-cli-X.Y.Z.tgz
farsight --version   # farsight X.Y.Z · built … · commit …
```

Node 24 is the supported runtime. How releases are cut: [docs/RELEASING.md](docs/RELEASING.md); what changed:
[CHANGELOG.md](CHANGELOG.md).

## Quickstart

From a checkout instead of a release:

```sh
pnpm install && pnpm build && node scripts/pack.mjs
npm install -g ./build/farsight-cli-*.tgz

farsight ingest .        # parse this very repo into graph.json
farsight serve           # explore it at http://localhost:4477
farsight mcp             # feed it to LLM agents over MCP
```

Full walkthrough (config, MCP setup, multi-repo): **[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**.

Click any node for docs, tags, rules, and connections; toggle **Business / Hybrid / Code** lenses; "Open in VS Code" deep-links to the exact source line.

**For agents:** the same graph feeds LLMs via MCP. This repo's [.mcp.json](.mcp.json) registers `farsight-mcp`, so a Claude Code session here can call `trace_flow("invoice process")`, `list_rules("finalize")`, or `impact_of(...)` and get end-to-end feature context — flows, validation rules, auth gates — with `file:line` refs, no grepping.

## Repository layout

```
docs/            Vision, architecture, roadmap, getting started, contracts, proposals
prototypes/      Self-contained HTML UX prototypes (the design-language reference)
examples/
  invoice-app/         Canonical demo repo (TS), ingested as its own source and used by the e2e suite
  spring-invoice-api/  A small Java/Spring API for the Java adapter
  claims-mini/         A small Next.js monorepo (route handlers, server actions, middleware)
packages/
  core/          Semantic Graph schema, store, queries (search/trace/journey/impact), config, string catalog
  parsers/       Language adapters (TS/JS via oxc-parser, Java), OpenAPI, design manifests, git history, test reports
  server/        App server: the HUD viewer + graph + settings/sources/sync API
  mcp/           MCP server — the graph as agent context (trace_flow, journey, impact_of, test_coverage…)
  cli/           The `farsight` binary: ingest / serve / mcp / status / api / tests / impact / stories / work
  work/          Work items (Jira / Azure DevOps) as a source: the common record, cache and policy
  work-jira/     Jira Cloud provider
  work-azdo/     Azure DevOps provider
  work-fixture/  A recorded fake tracker for tests and e2e
  app/           Phase-2 canvas GUI (placeholder; the current viewer lives in server/public)
e2e/             Playwright e2e suite against a real `farsight serve` on a fixture graph
schemas/         JSON Schemas of the frozen machine-readable contracts (farsight-diff v1, …)
scripts/         pack.mjs (installable tarball), changelog.mjs + release.mjs (releases), lint-strings.mjs, e2e.mjs
tools/recap-md/  A local-LLM markdown recap tool, the Model Hub's dogfood emitter
.farsight/       Workspace settings: sources (with exclude globs), collections, theme — `settings.json` is local; copy `settings.example.json` to start
```

## Status

Working today: multi-source ingest with glob exclusions (local folders + git URLs), the lens-switching HUD viewer (⌘K search, focus mode, in-place expandable groups, guard/rule badges, right-click actions, dark/light themes, source collections), JSDoc augmentation (`@business` / `@group` / `@tag`), journeys (timeline, sheet, ladder, storyboard), impact and test-selection output, API and design drift, tests and coverage linked to journeys, change history, Storybook stories, work items from Jira and Azure DevOps, the MCP agent surface, and an installable CLI. This repo dogfoods itself — `farsight` and `invoice-app` are its own configured sources.

Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md); design rationale in [docs/VISION.md](docs/VISION.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); what's next in [docs/ROADMAP.md](docs/ROADMAP.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security model and how to report a vulnerability: [docs/SECURITY.md](docs/SECURITY.md). AI sessions: see [AGENTS.md](AGENTS.md).
