# Farsight — guidance for AI sessions

Farsight parses codebases (TS/JS today) into a **semantic graph** and serves it three ways: a game-HUD web viewer, an MCP server for agents, and a CLI. It is dogfooded on itself — this repo is one of its own sources.

Read in order when context is needed: [docs/VISION.md](docs/VISION.md) (why + personas), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (design + ADRs), [docs/ROADMAP.md](docs/ROADMAP.md) (what's done/next), [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) (user-facing walkthrough).

## Shared provider memory

This file is the canonical project guidance for Codex/GPT and Claude Code. `CLAUDE.md` imports it; update this file instead of maintaining two copies. Read [docs/AI-HANDOFF.md](docs/AI-HANDOFF.md) at session start for the verified setup, latest validation, and handoff notes. Keep durable project facts here and dated results there. Provider-private memories are historical hints; current code and repository docs take precedence.

Use Node 24+ (`.nvmrc`) and pnpm 9.0.0. Build before tests, which import `dist/`. Put a Node 24 on PATH (`nvm use`) before building. Before changing work, inspect `git status`; preserve another provider's uncommitted edits. For concurrent implementation use separate worktrees, and record branch, changes, checks, and unresolved issues in the handoff before switching providers. Shared instructions do not imply shared permissions, authentication, or live MCP connections.

**Preserve the dogfood graph:** bare CLI ingest replaces `graph.json` with a single source and does not apply workspace source excludes. Refresh the existing multi-source graph using the restarted workspace server's `POST /api/sync`. For isolated validation, run the absolute CLI path from a temporary directory with an explicit `--out`; snapshots are written relative to cwd too. Restart MCP connections after rebuilding or changing tools.

## Core principles (do not violate)

1. **One graph, many lenses.** Language adapters emit the same schema (`packages/core/src/graph.ts`); every consumer (viewer lens, MCP tool, CLI) is a view over it. Never fork the schema per consumer.
2. **Code is the source of truth.** Docs/JSDoc (`@business`, `@group`, `@tag`) *augment* the graph; they never replace what parsing found. Diagrams are derived, never hand-drawn.
3. **Two audiences, same nodes.** Every feature must work for developers *and* business users — that's what lenses/glossary/humanize() are for. Business lens hides code; hybrid shows both names.
4. **Usability framing.** Features are judged by: "can someone identify part of the system, understand what the code does, and decide how to change it?"

## Git conventions (adopted 2026-07)

Conventional commits (`feat(parsers): …`, `fix(cli): …`, `docs: …` — scope = package name) on a feature branch per pass (`feat/…`, `fix/…`), merged to `main` with `--no-ff`. History before July 2026 predates this; don't imitate its long one-line style.

## Commands

```sh
pnpm install && pnpm build          # build all packages (tsc, topological)
pnpm -r typecheck                   # typecheck everything
pnpm -r test                        # node --test suites (build first — tests import dist/)
pnpm lint:strings                   # viewer string/symbol grammar gate
pnpm e2e                            # Playwright e2e (build first): real `serve` on a fixture graph at :4510 + the MCP data-flow spec (:4511); stamps e2e/test-results/results.json, which the dogfood `tests.e2e` block reads. No MSW (ADR 8) — faults via page.route; see .claude/skills/e2e-playwright
node packages/cli/dist/cli.js --version                  # which build: version · built · commit (also MCP graph_overview, /api/version, the HUD sync-chip tooltip)
node packages/cli/dist/cli.js status [--port 4477]       # is anything out of date: installed build vs the server on the port vs the build that wrote the graph, + the check/update/restart/reingest steps (exit 1 when action is needed); the same recipe ends MCP graph_overview, rides on /api/version as `install`/`currency`, and puts RESTART on the HUD sync chip
node packages/cli/dist/cli.js ingest . --repo farsight   # CLI ingest
node packages/cli/dist/cli.js serve graph.json           # viewer on :4477
node packages/cli/dist/cli.js mcp --graph graph.json     # MCP over stdio
node packages/cli/dist/cli.js api list                    # API surfaces (spec-backed / implied) with drift counts
node packages/cli/dist/cli.js api diff --spec x.yaml --repo r --strict   # proposed spec vs code; exit 1 on drift
node packages/cli/dist/cli.js tests list|matrix [--format csv]  # tests in the graph: suites with last run + freshness; journeys × tests (declared / inferred / observed), coverage floor|exact, gaps
node packages/cli/dist/cli.js impact <id> [--hops N] [--tests] [--json]  # what depends on this, per hop, never summed; --json is the frozen farsight-impact-tests v1 document for CI test selection
node packages/cli/dist/cli.js stories [--repo r] [--node <id>] [--json]   # the repos' Storybooks (found or configured, never started), running or not, and how the live index maps onto components (ADR 9)
node packages/cli/dist/cli.js tests import --results r.json --coverage coverage-final.json --repo r  # attach a CI report to an existing graph without re-ingesting
node packages/cli/dist/cli.js work sync|status|list|show <key>|links <key>   # work items (Jira / Azure DevOps) from the work.db cache; --json on list = farsight-work v1
node packages/cli/dist/cli.js work comment|assign|move|edit|link <key> …      # edit-mode writes: prints the three verdicts (policy · tracker · credential) and the outcome; exit 2 = waiting for --confirm
FARSIGHT_LIVE=1 pnpm -r test        # also run the live tracker tests (Jira writes a comment on the test site; ADO dry-runs only) — opt-in, never by default; point them at your own site/org with FARSIGHT_JIRA_SITE / FARSIGHT_JIRA_USER / FARSIGHT_JIRA_KEYCHAIN and FARSIGHT_ADO_ORG / FARSIGHT_ADO_PROJECT / FARSIGHT_ADO_KEYCHAIN (the defaults are example.atlassian.net and dev.azure.com/example-org)
node scripts/pack.mjs               # build installable farsight-cli tarball into build/ (stamps version · built · commit into the bundle)
npm install -g ./build/farsight-cli-*.tgz # the global `farsight` another workspace runs (serve + .mcp.json) — reinstall after every pass, then restart its server
curl -X POST localhost:4477/api/sync # re-ingest all enabled sources via server
node scripts/changelog.mjs --dry-run              # the next CHANGELOG section + release notes, from conventional commits since the last tag
node scripts/release.mjs --dry-run --bump patch   # what a release would bump and write (the workflow adds --no-tag --branch 'release/v{version}' --commit-notes; never pushes)
gh workflow run release.yml -f bump=patch         # open a release PR (main is protected): gates, version commit on release/vX.Y.Z, smoke test, PR; merging it runs publish.yml → tag, GitHub Release with the tarball (docs/RELEASING.md)
```

The Claude preview/dev server is defined in `.claude/launch.json` (name: `farsight-viewer`, port 4477). Codex can run the same CLI serve command from the workspace root; there is no `.codex/launch.json`.

## Gotchas that have bitten before

- **Restart the server after rebuilding packages** (and re-pack + `npm install -g` when a consumer runs the global `farsight`; `farsight status` / `farsight --version` / MCP `graph_overview` say which build is live and what to do). The running server holds compiled modules in memory but serves the viewer files from disk, so after a reinstall the browser runs NEW viewer code against OLD `/api/*` (symptoms: raw `journey.*` string keys, a journey band without `moments`) until the process is restarted; `/api/sync` will use stale parser code until restart too. Then reload the browser page (it caches `/graph` from load time).
- **A machine with two Node prefixes has two global `farsight` installs** (say, the default shell's Node and a separate Node 24 runtime). `npm install -g` updates only the prefix of the `node` on PATH, so after a pack run it under **both** (`which -a farsight` to check), or a workspace whose `.mcp.json` resolves the other prefix keeps a weeks-old CLI while `farsight --version` in your shell looks current.
- **To see a viewer change, run `node packages/cli/dist/cli.js serve` from the workspace — never the global `farsight serve`**, which bundles its own copy of `public/app` and quietly serves old viewer files. This has produced false negatives that were believed for a while.
- **A negative result may be someone else's server.** `serve` refuses an occupied port quietly, so a second `serve` does nothing and your `curl` hits whatever was already listening. Run `lsof -nP -iTCP:<port> -sTCP:LISTEN` before believing a measurement — especially one that says nothing changed.
- **Screenshot with the root `@playwright/test`** (a devDependency; `import { chromium } from '@playwright/test'` from a script in the workspace). Open one **fresh page per shot**, wait on the surface's own selector, and collect `pageerror` + console errors — that count is the cheapest real check there is. Judge a visual change by *looking at the PNG*, not by querying the DOM.
- **`graph.json` and `build/` are gitignored.** Fresh checkouts must run ingest (or `/api/sync`) before `serve`/`mcp` work.
- **Never write `**/*.test.ts`-style globs inside `/** … */` doc comments** — the `*/` terminates the comment (this broke a build). Use line comments.
- **Duplicate symbol names are normal** (e.g. `finalizeInvoice` exists in client *and* service). Always disambiguate by full node id `repo::path::name` when debugging graph content.
- **esbuild preserves the entry file's shebang** — don't also add a `banner` in `scripts/pack.mjs` (caused a double-shebang crash).
- oxc-parser's `result.program` may be an object or a JSON string depending on version — `tsjs.ts` handles both; keep that guard.
- **This repo is public.** Client material, session handoffs and review evidence live outside it (a private folder the owner keeps); never add a client name, a site/org URL, an email, a keychain account name or an absolute home path here. Examples use `example.atlassian.net`, `dev.azure.com/example-org`, `dev@example.com`, `keychain:farsight/jira-example`, and "the reference app" for the application Farsight was dogfooded on.
- **Local config is never tracked; each file has a scrubbed `.example` twin** (CONTRIBUTING.md § Local config): `.farsight/settings.json` ← `.farsight/settings.example.json`, `.claude/settings.local.json` ← `.claude/settings.local.example.json`. Copy the example, never commit a value from the local file; a new local config gets its twin in the same change. The server falls back to a one-source workspace without settings.
- **Secrets live in the keychain only** (2026-09-30): `keychain:farsight/<provider>-<instance>` references in settings, read in-process by `packages/work/src/secrets.ts`, never an env var or a value in a file; the auto-mode classifier refuses a bare `security find-generic-password` in a shell, so a live check runs the tool or a probe script that prints only the outcome. `GET /api/settings` serves the settings file back and the viewer rewrites it wholesale — a value there would leak.
- **Work keys only count for configured projects.** `detectWorkKeys` reads `INV-01` (a screen name) as a Jira key; the join (`joinWork`) links only keys whose project is in a work source's scope, and a leading-zero key never links.
- **`farsight.config.json` is applied inside `ingestRepo()`** (function guards/tags/glossary before the OpenAPI pass, route-shaped guards after it). Never call `applyConfig` again on the result — guard renames are not idempotent.

## Where the detail lives — load on demand

This file is the contract and is read at the start of every session, so it stays short. The reference material
moved out; open a map when you need it, not to orient.

| open this | when |
|---|---|
| [docs/MAP-PACKAGES.md](docs/MAP-PACKAGES.md) | finding where something lives — every package, file by file, with what each module owns |
| [docs/MAP-VIEWER.md](docs/MAP-VIEWER.md) | before editing `packages/server/public/*` — the ES-module split, the journey's four views, the band and drill mechanics, the surfaces |
| [docs/SECURITY.md](docs/SECURITY.md) | touching the server's routes, secrets, tracker writes or recorded fixtures — the threat model, the request guard, the CI secret scan |
| [docs/CI.md](docs/CI.md) | changing the GitHub Actions workflow, reading a red check, or running exactly what CI runs |
| [docs/COUNTS.md](docs/COUNTS.md) | before printing, changing or defending a number — every count the product prints, its source field, what it counts, the scope it counts over, and the `Counted` shape a surface wires |
| [docs/AI-HANDOFF.md](docs/AI-HANDOFF.md) | at session start — the verified current state and the ranked next work |
| [docs/proposals/](docs/proposals/) | how a design was argued before it was built |
| [docs/review-swarm.md](docs/review-swarm.md) | how to run the eight review personas (their reports stay out of the repo) |
| [docs/VISION.md](docs/VISION.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/ROADMAP.md](docs/ROADMAP.md) | why the product exists, its ADRs, what is done and next |

**The invariants that always apply, wherever you are working.** Every user-facing string goes through the
two-register catalog (`packages/core/src/strings.ts`) with both registers and a `define`; every glyph goes
through `sym()`; `pnpm lint:strings` enforces both, and its RULE 5 bans developer units from the business
register. `farsight-diff v1`, `farsight-tests-matrix v1` and `farsight-impact-tests v1` are **frozen and
additive-only**, each pinned by a test asserting its enums against an explicit literal list *and* its schema
file. Every number arrives as a `Counted` (core `counts.ts`: words, scope, source, a breakdown that sums) and
is listed in `docs/COUNTS.md`; *verified* means a results report named a case that ran over the code — a
coverage report alone is *seen by a coverage run*. The six absence words are a closed set and the three evidence classes are a closed set — adding a seventh
or a fourth is the failure mode the clarity phase existed to remove. No number moves without evidence, and every
number names what it counts and the scope it counts over. Every number and every detail carries a tip (`lib/tooltip.js`, see
[docs/MAP-VIEWER.md](docs/MAP-VIEWER.md#tooltips--libtooltipjs-2026-09-25)) built from the catalog's `define` and its scope.

## Design language ("Farsight HUD")

Blue-black ground `#0A0D14`, panels `#111623`, condensed-uppercase HUD labels (Futura/Avenir Next Condensed), SF Mono for code/data. **Two meaning-bearing accents: quest-amber `#F0B44E` = business lens, signal-cyan `#5BC8DD` = code/hybrid lens** — switching lens warms/cools the chrome. Node kind colors: component green `#6FCF8E`, route cyan, function gold `#D8C27A`, table violet `#C287D6`, guard/auth purple `#A78BE0`, rule/warn `#E8A13C`. Light theme exists (`[data-theme="light"]`). Game vocabulary: quest log = saved flows, fog of war = unindexed, fast travel = ⌘K.

## Current position

The clarity phase is built and merged; three passes have followed it. **`docs/AI-HANDOFF.md` carries the
verified current state and the ranked next work — read it, not this paragraph.**

The bar the product is judged against, unchanged: *"a person who opens Farsight on a real application understands
the app before they understand the tool."* As of the 2026-09-24 visual swarm a reader new to the reference app
**can** explain its invoice submission unaided from the front door and the journey; what the swarm still marks down
is presentation, not truth — in its own words, *"the content work has outrun the presentation work."*

## Dispatching subagents (learned 2026-09-24)

`git stash` is shared state too, and it does not look like it. **One stash stack serves every worktree of a
repository.** Two agents in separate worktrees stashed at the same moment and their pops crossed — each ended up
holding the other's uncommitted work (2026-09-24; recovered, nothing lost). An agent capturing a before/after
baseline must commit on its own branch and diff against that, or copy the file to its scratchpad — never
`git stash`, and never `git checkout main` in a worktree that has uncommitted work.

A subagent that cleans up with `pkill -f "cli.js serve"` will kill the lead's live servers on 4477
and 4478, because those run `node packages/cli/dist/cli.js serve …`. Tell an agent to stop its own
servers **by port** (`pkill -f "port 45xx"` or the recorded pid), never by a pattern that matches
the command shape. One agent did this, reasoned from the global install's command line that it
could not have, and flagged the uncertainty anyway — which is the only reason it was caught.
