# Farsight

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

## Quickstart

```sh
pnpm install && pnpm build && node scripts/pack.mjs
npm install -g ./build/farsight-cli-0.0.1.tgz

farsight ingest .        # parse this very repo (65 nodes in ~23ms)
farsight serve           # explore it at http://localhost:4477
farsight mcp             # feed it to LLM agents over MCP
```

Full walkthrough (config, MCP setup, multi-repo): **[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**.

Click any node for docs, tags, rules, and connections; toggle **Business / Hybrid / Code** lenses; "Open in VS Code" deep-links to the exact source line.

**For agents:** the same graph feeds LLMs via MCP. This repo's [.mcp.json](.mcp.json) registers `farsight-mcp`, so a Claude Code session here can call `trace_flow("invoice process")`, `list_rules("finalize")`, or `impact_of(...)` and get end-to-end feature context — flows, validation rules, auth gates — with `file:line` refs, no grepping.

## Repository layout

```
docs/            Vision, architecture, roadmap, getting started
prototypes/      Self-contained HTML UX prototypes (the design-language reference)
examples/
  invoice-app/   Canonical demo repo, ingested as its own source
packages/
  core/          Semantic Graph schema, store, queries (search/trace/impact), config
  parsers/       Language adapters (ts-js via oxc-parser; tree-sitter next)
  server/        App server: viewer + graph + settings/sources/sync API
  mcp/           MCP server — the graph as agent context (trace_flow, list_rules…)
  cli/           The `farsight` binary: ingest / serve / mcp
  app/           Phase-2 canvas GUI (placeholder; current viewer is interim)
scripts/         pack.mjs — builds the installable farsight-cli tarball
.farsight/       Workspace settings: sources (with exclude globs), collections, theme — `settings.json` is local; copy `settings.example.json` to start
```

## Status

Phase 1 complete, plus a settings/usability pass. Working today: multi-source ingest with glob exclusions (local folders + git URLs), the lens-switching HUD viewer (⌘K search, focus mode, in-place expandable groups, guard/rule badges, right-click actions, dark/light themes, source collections), JSDoc augmentation (`@business` / `@group` / `@tag`), the six-tool MCP agent surface, and a globally installable CLI. This repo dogfoods itself — `farsight` and `invoice-app` are its own configured sources.

Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md); design rationale in [docs/VISION.md](docs/VISION.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); what's next in [docs/ROADMAP.md](docs/ROADMAP.md). AI sessions: see [CLAUDE.md](CLAUDE.md).
