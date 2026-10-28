# Farsight — guidance for AI sessions

Farsight parses codebases (TS/JS today) into a **semantic graph** and serves it three ways: a game-HUD web viewer, an MCP server for agents, and a CLI. It is dogfooded on itself — this repo is one of its own sources.

Read in order when context is needed: [docs/VISION.md](docs/VISION.md) (why + personas), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (design + ADRs), [docs/ROADMAP.md](docs/ROADMAP.md) (what's done/next), [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) (user-facing walkthrough).

## Shared provider memory

This file is the canonical project guidance for Codex/GPT and Claude Code. `CLAUDE.md` imports it; update this file instead of maintaining two copies. Read [docs/AI-HANDOFF.md](docs/AI-HANDOFF.md) at session start for the work in flight: where `main` is, what is open and next. It is loaded into every session, so it stays short — rewrite its entries, never append. Dated results (checks run, measurements, review findings) go to the top of the matching [docs/history/](docs/history/README.md) file, read on demand; runtime, provider and live-tracker setup is in [docs/AI-SETUP.md](docs/AI-SETUP.md). Keep durable project facts here. Provider-private memories are historical hints; current code and repository docs take precedence.

Use Node 24+ (`.nvmrc`) with pnpm 9.0.0 or npm 10 (`npm install`, `npm run build`); pnpm remains the contributor and CI path. The sole committed lockfile is pnpm’s; npm uses `npm install`, not `npm ci`. Build before tests, which import `dist/`. Put a Node 24 on PATH (`nvm use`) before building. Before changing work, inspect `git status`; preserve another provider's uncommitted edits. Before switching providers, rewrite the handoff's entries with the branch, changes, checks and unresolved issues. Shared instructions do not imply shared permissions, authentication, or live MCP connections.

**Work in a worktree, never in the primary checkout** (learned 2026-10-17, PR #115). The primary checkout is the dogfood server's workspace: `pnpm build` there rewrites the `dist/` the 4478 server restarts into (`farsight status` and the HUD chip then say RESTART into a feature build), `pnpm e2e` there stamps `e2e/test-results/results.json`, which the dogfood graph reads as its own e2e run, and a branch left checked out there is what the next session's `git status` starts from. Every implementation, Codex or Claude, concurrent or not, happens in its own worktree (`git worktree add ../farsight-wt/<name> -b <branch>`; Codex's live under `~/.codex/worktrees/`); the primary checkout stays on `main` with a `main` build. If you did build or test in the primary checkout, say so in the handoff, check `main` out again and rebuild before handing off.

**Validate affected work only.** Use the change-to-check table in [docs/CI.md](docs/CI.md) for local checks too.
Ordinary Markdown documentation edits need no build, unit tests or e2e; packaged docs and test fixtures are the
exceptions. CI uses `scripts/ci-changes.mjs` to select suites, with full checks for shared or unknown inputs.

**Preserve the dogfood graph:** bare CLI ingest replaces `graph.json` with a single source and does not apply workspace source excludes. Refresh the existing multi-source graph using the restarted workspace server's `POST /api/sync`. For isolated validation, run the absolute CLI path from a temporary directory with an explicit `--out`; snapshots are written relative to cwd too. Restart MCP connections after rebuilding or changing tools.

**A parser, core or store change is measured on a real ingest, against a `main` build** (2026-10-17): fixtures prove the code moved intact, not what the product now ships. Build `main` in a second worktree, ingest this repository with both builds from scratch directories, and compare node and edge sets, `meta.sourceDigest`, `graph.json` bytes and the `.farsight/farsight.db` size; serve the new graph and collect page errors on the front door, the Map and the code map. Put the before/after numbers in the PR body. A new field on every node or edge grows `/graph`, the payload the handoff names as the ceiling, so it ships with a consumer or stays out of the application graph until one exists.

## Working mode: who is who

Jared names agents by model family. **Sol** (also written SOL) is the Codex agent — every Codex session: the ChatGPT.app
Codex desktop, the `codex` CLI, or one started through the `agent_bridge` MCP. **Fable** is the lead Claude session: it
reads the docs and memory, plans lanes with explicit file ownership, dispatches, reviews every report and merges. **Opus**
workers are Claude's implementation, research and review subagents, defined in `.claude/agents/` (here, the eleven
`review-*` personas); their Codex mirrors are the `.codex/agents/*.toml` files with the same names, and a mirror runs on
Sol's model. **Sonnet** and **Haiku** are the cheaper Claude models for read-only or routine work. In Farsight, Sol
implements and corrects, Claude reviews independently, and the lead integrates and owns the definition of done.

What Sol loads natively here: `~/.codex/AGENTS.md`, this file (so *read `docs/AI-HANDOFF.md` at session start* is a real
instruction, not a formality — nothing imports it for Codex), `.codex/agents/*.toml`, the MCP servers in `.codex/config.toml`,
and skills from `.agents/skills/` — a tracked copy of `.claude/skills/` that `scripts/check-skills-mirror.mjs` keeps identical
(run by `pnpm test:scripts`; make every skill edit in both trees). The full roster with models and how each agent is reached
is the machine-level memory of each assistant (`~/.claude/memory/agent-roster.md`, `~/.codex/memory/agent-roster.md`); the
bridge's setup, status and recovery live in `~/.codex/scripts/agent-bridge/README.md`.

## Core principles (do not violate)

1. **One graph, many lenses.** Language adapters emit the same schema (`packages/core/src/graph.ts`); every consumer (viewer lens, MCP tool, CLI) is a view over it. Never fork the schema per consumer.
2. **Code is the source of truth.** Docs/JSDoc (`@business`, `@group`, `@tag`) *augment* the graph; they never replace what parsing found. Diagrams are derived, never hand-drawn.
3. **Two audiences, same nodes.** Every feature must work for developers *and* business users — that's what lenses/glossary/humanize() are for. Business lens hides code; hybrid shows both names.
4. **Usability framing.** Features are judged by: "can someone identify part of the system, understand what the code does, and decide how to change it?"

## Git conventions (conventional commits since 2026-07; PR-only, squash-merged `main` since 2026-10-04)

Every change is a branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`) and a pull request into `main`; nothing is committed or merged on `main` locally. **PRs are squash-merged** (`gh pr merge --squash`, the only kind `main` accepts), so one PR = one commit on `main` = one line in the changelog. That makes **the PR title the commit that matters**: it must be a [Conventional Commit](https://www.conventionalcommits.org/), `type(scope): what changed` with an optional package or surface scope (`feat(parsers): …`, `fix(cli): …`, `docs: …`; the full type and scope lists live in `scripts/lint-commits.mjs`), and the PR body — the template `.github/PULL_REQUEST_TEMPLATE.md`: *what changed · why · how it was checked · left open* — becomes that commit's message. Commits on the branch are conventional too (the `commit-msg` hook that `pnpm install` installs and CI's required `commits` check both run `scripts/lint-commits.mjs`; `pnpm lint:commits --message '…'` tries a subject), but they are working notes: commit often and leave them as they are, the squash folds them. Never `--admin`, never a local merge into `main`, never `git stash` (see *Dispatching subagents*). History before July 2026 predates the convention; history before 2026-10-04 has merge commits — don't imitate either.

**Required for both Codex and Claude:**

- Every authored commit and PR title follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
  `type: summary` or `type(scope): summary`. Scope is optional; use a registered scope when present. `feat` adds a
  feature, `fix` repairs a bug, and `!` or a `BREAKING CHANGE:` footer marks a breaking change.
- Validate the exact PR title with `pnpm lint:commits --message '…'` before create/edit/merge.
  Preserve it as the squash-commit subject; the template-based PR body becomes its message.
- PR/review feedback uses [Conventional Comments](https://conventionalcomments.org/): `label (blocking|non-blocking):
  subject`, with a reason and requested action where useful. Notes/nitpicks are non-blocking. Correct your own
  noncompliant material; preserve others' work. These labels do not apply to source-code comments or ordinary chat.
- Every commit an assistant authors ends with a `Co-Authored-By: <assistant> <address>` trailer, the one its tool
  emits. Farsight's own *commits made with an agent* fact (`core/agent-trailer.ts`) reads that trailer and nothing
  else, so a branch without it under-counts the dogfood graph. Never a session link or a transcript id (the repo is
  public).
- A new package, public contract or package boundary gets an ADR in `docs/ARCHITECTURE.md` in the same PR, beside
  the `docs/MAP-PACKAGES.md` entry; the proposal argues it, the ADR records what was decided.

## Commands

```sh
pnpm install --frozen-lockfile --ignore-scripts && pnpm build # linked worktree: build all packages
pnpm -r typecheck                   # typecheck everything
pnpm -r test                        # node --test suites (build first — tests import dist/)
pnpm lint:strings                   # viewer string/symbol grammar gate
pnpm format                         # format eligible JS/TS only; remove a temporary ignore line in its style PR
pnpm format:check                   # Prettier (JS/TS only; .prettierignore lists areas awaiting style PRs)
pnpm lint                          # ESLint errors; existing violations frozen in eslint-suppressions.json
pnpm lint:report                   # include structure warnings; prune fixed debt with pnpm lint --prune-suppressions
pnpm verify:format -- origin/main   # style PRs: prove changed JS/TS programs are AST-equivalent
pnpm e2e                            # Playwright e2e (build first): real `serve` on a fixture graph at :4510 + the MCP data-flow spec (:4511); stamps e2e/test-results/results.json, which the dogfood `tests.e2e` block reads. No MSW (ADR 8) — faults via page.route; see .claude/skills/e2e-playwright
node packages/cli/dist/cli.js --version                  # which build: version · built · commit (also MCP graph_overview, /api/version, the HUD sync-chip tooltip)
node packages/cli/dist/cli.js status [--port 4477]       # is anything out of date: installed build vs the server on the port vs the build that wrote the graph, + the check/update/restart/reingest steps (exit 1 when action is needed); the same recipe ends MCP graph_overview, rides on /api/version as `install`/`currency`, and puts RESTART on the HUD sync chip
node packages/cli/dist/cli.js ingest . --repo farsight   # CLI ingest
node packages/cli/dist/cli.js serve graph.json [--read-only]   # viewer on :4477; --read-only (and every --as-of) refuses PUT /api/settings, POST /api/sync and /api/work writes, shows the READ-ONLY chip and greys every write control — start a reviewer's server this way
node packages/cli/dist/cli.js mcp --graph graph.json     # MCP over stdio
node packages/cli/dist/cli.js api list                    # API surfaces (spec-backed / implied) with drift counts
node packages/cli/dist/cli.js api diff --spec x.yaml --repo r --strict   # proposed spec vs code; exit 1 on drift
node packages/cli/dist/cli.js tests list|matrix [--format csv]  # tests in the graph: suites with last run + freshness; journeys × tests (declared / inferred / observed), coverage floor|exact, gaps
node packages/cli/dist/cli.js impact <id> [--hops N] [--tests] [--json]  # what depends on this, per hop, never summed; --json is the frozen farsight-impact-tests v1 document for CI test selection
node packages/cli/dist/cli.js affected --pr <n> | --from <sha> --to <sha> [--json] [--post [--confirm] [--via gh]]  # what a change touches: journeys (storyline step), gates, record writes and calls on the changed path, each test case once with its own last run; --json = frozen farsight-affected v1; --post = one comment + one check through the three verdicts (a `type: 'code-host'` source)
node packages/cli/dist/cli.js readiness --storyline <id> [--repo r] [--json|--csv]  # the release readiness brief: one row per step, ship or hold with the reason, the rules register (also #/readiness/<id>)
node packages/cli/dist/cli.js state [--json]                  # the state of play: built and walkable · validated by a run · still open, every number with the command that re-checks it (also GET /api/state, the front door, the top of MCP graph_overview)
node packages/cli/dist/cli.js stories [--repo r] [--node <id>] [--json]   # the repos' Storybooks (found or configured, never started), running or not, and how the live index maps onto components (ADR 9)
node packages/cli/dist/cli.js tests import --results r.json --coverage coverage-final.json --repo r  # attach a CI report to an existing graph without re-ingesting
node packages/cli/dist/cli.js journeys [--repo r] [--persona p] [--group g] [--storyline s] [--json]   # the journeys organised persona → group → journeys in declared order (manifest personas[]/groups[]/flow persona·group·order, farsight.config.json → journeys overrides); the same tree as GET /api/journeys and MCP `journeys`
node packages/cli/dist/cli.js config list [--repo r] [--json]  # every farsight.config.json a source has (root + nested, each scoped to its folder), the fields each gives, conflicts and notes; the same as MCP `config_files` and GET /api/config
node scripts/synth-graph.mjs --preset small|full --out build/synth.json   # a seeded synthetic workspace (full = 1,000 NX projects · 245k nodes · 300 journeys) for the perf table
pnpm e2e:perf                       # the thousand-project table per surface (first draw · one interaction · long tasks · heap) against budgets; CI runs the small preset inside pnpm e2e
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

- **Lefthook and linked worktrees:** `lefthook.yml` must never name the Git LFS hooks (`pre-push`, `post-checkout`,
  `post-commit`, `post-merge`). Linked worktrees share one hooks directory; keep `no_auto_install: true` so a commit
  cannot rewrite everybody's hooks. Never pop a `lefthook auto backup` stash entry; the stash stack is shared too.
  `pnpm install` explicitly installs the two managed hooks; pre-commit formats and re-stages eligible JS/TS files.
  An install from a worktree embeds that worktree's absolute lefthook binary path in the shared hooks, which breaks
  when the worktree is removed. After a worktree PR merges, run `pnpm install` once in the primary checkout so the hooks
  point at a lasting path. A branch without `lefthook.yml` silently skips the commit-msg lint and main-branch guard;
  it relies on CI's `commits` check until it rebases. Never commit on main from a worktree whose branch predates lefthook.
- **Linked worktree installs:** never run bare `pnpm install` there; use `pnpm install --frozen-lockfile --ignore-scripts`, then run `pnpm install` in the primary checkout after the PR merges to restore the lasting hook path.
- **PR base branch:** check `gh pr view <n> --json baseRefName` says `main` before every merge; squash-merging a stacked PR into its parent does not land it on `main`.
- **Changed pnpm hoisting:** after pulling this change into an existing worktree, run
  `pnpm install --config.confirm-modules-purge=false --ignore-scripts` once. With changed `.npmrc` hoist settings, pnpm 9 asks to purge
  `node_modules`; a non-TTY shell can silently exit 0 without installing. CI's fresh install is unaffected.
- **The CI lint check:** `pnpm format:check` and `pnpm lint` run when runtime checks are selected; `style` PRs also
  prove AST equivalence against their merge base. The lead adds `lint` to required checks after its first green run.
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
- **Never fold the graph per node in the viewer** (2026-10-04): a 7 ms fold called from a per-node predicate is minutes on a
  21k-node graph (the grouped code map hung). The code map holds one index per graph object (`lib/codemap-model.js`
  `buildCodemapIndex`) and answers every per-node question — project, group, filtered, test file, rule badges — by a
  lookup; a filter is set algebra over the index (`passFor`). `store.js indexGuards()` carries the edge indexes
  (`guardsByTarget`, `validatesByTarget`, `EDGES_OF`). A new per-card scan of `S.GRAPH.edges` or `S.GRAPH.nodes` is the
  regression; `packages/server/test/codemap-perf.test.ts` guards the fold under 2 s on a synthetic 20k-node graph.
- **NX's project graph is read, never produced.** `parsers/src/shared/nx-graph.ts` reads the file NX wrote (or
  `projects.graphFile`) inside the source only, capped at 20 MB, names validated against discovery; Farsight never runs
  `nx` (`docs/SECURITY.md`). Imports read from the files stay the primary evidence; NX's graph augments.
- **`farsight.config.json` is applied inside `ingestRepo()`** (function guards/tags/glossary before the OpenAPI pass, route-shaped guards after it). Never call `applyConfig` again on the result — guard renames are not idempotent.

## Where the detail lives — load on demand

This file is the contract and is read at the start of every session, so it stays short. The reference material
moved out; open a map when you need it, not to orient.

| open this | when |
|---|---|
| [docs/MAP-PACKAGES.md](docs/MAP-PACKAGES.md) | finding where something lives — every package, file by file, with what each module owns |
| [docs/MAP-VIEWER.md](docs/MAP-VIEWER.md) | before editing `packages/server/public/*` — the ES-module split, the five stops a journey is read at on the Map, the band and drill mechanics, the surfaces |
| [docs/SECURITY.md](docs/SECURITY.md) | touching the server's routes, secrets, tracker writes or recorded fixtures — the threat model, the request guard, the CI secret scan |
| [docs/CI.md](docs/CI.md) | changing the GitHub Actions workflow, reading a red check, or running exactly what CI runs |
| [docs/COUNTS.md](docs/COUNTS.md) | before printing, changing or defending a number — every count the product prints, its source field, what it counts, the scope it counts over, and the `Counted` shape a surface wires |
| [docs/AI-HANDOFF.md](docs/AI-HANDOFF.md) | at session start — the work in flight and the ranked next work |
| [docs/history/](docs/history/README.md) | why something is the way it is — every pass's dated checks, measurements, review findings and left-open lists, one file per area |
| [docs/AI-SETUP.md](docs/AI-SETUP.md) | setting up a runtime, a provider's MCP access or a live tracker test |
| [docs/proposals/](docs/proposals/) | how a design was argued before it was built |
| [docs/review-swarm.md](docs/review-swarm.md) | how to run the eight review personas and the three outsiders (their reports stay out of the repo) |
| [docs/VISION.md](docs/VISION.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/ROADMAP.md](docs/ROADMAP.md) | why the product exists, its ADRs, what is done and next |

**The invariants that always apply, wherever you are working.** Every user-facing string goes through the
two-register catalog (`packages/core/src/strings.ts`) with both registers and a `define`; every glyph goes
through `sym()`; `pnpm lint:strings` enforces both, and its RULE 5 bans developer units from the business
register. `farsight-diff v1`, `farsight-tests-matrix v1`, `farsight-impact-tests v1` and `farsight-affected v1` are **frozen and
additive-only**, each pinned by a test asserting its enums against an explicit literal list *and* its schema
file. Every number arrives as a `Counted` (core `counts.ts`: words, scope, source, a breakdown that sums) and
is listed in `docs/COUNTS.md`; *verified* means a results report named a case that ran over the code — a
coverage report alone is *seen by a coverage run*. The six absence words are a closed set and the three evidence classes are a closed set — adding a seventh
or a fourth is the failure mode the clarity phase existed to remove. No number moves without evidence, and every
number names what it counts and the scope it counts over. Every number and every detail carries a tip (`lib/tooltip.js`, see
[docs/MAP-VIEWER.md](docs/MAP-VIEWER.md#tooltips--libtooltipjs-2026-09-25)) built from the catalog's `define` and its scope.
**One verdict, one freshness fact, one gate card** (2026-10-06): a test cell's word and status come from core
`testVerdict()` (`coverage.ts`) and nothing else — no surface folds its own weakest run or its own tip status; *stale*
is printed only by core `freshness.ts` and only with both sides (*ran on commit X · the code is at Y*), a run without
a digest says *no source digest*, never *stale*; a gate click anywhere opens the one card (`lib/gate-card.js` over
`GET /api/gate`), and a guard that reads the environment and takes no request is a *config check*, counted apart and
never a screen's gate. *Step* is the storyline position only; the Sheet's columns are *stops*. A new catalog module is
a `strings-<area>.ts` registered the way `strings-doors.ts` is, so lanes do not collide in `strings.ts`.
**One surface, five stops; scope on the chip; a tier on every gate** (2026-10-10): the Map is the one place a journey
is read — ALL · JOURNEY · SCREEN · ACTION · CODE on one zoom (`surfaces/map-stops.js`), with one LAYOUT control whose
choices change per stop (`registerMapLayout`); the journey's pure folds live in `lib/journey-model.js`, never in a
surface, and its drawing in `lib/journey-draw.js`. There is no second journey page: a door to a journey writes
`#/map/<flow>` (an old `#/journeys/<entry>…` link is rewritten by `route-url.js overlayToMap`), *step* is the storyline
position and a Map address names a `screen`. Every test number prints through `lib/test-chip.js` with the scope it counts over (`TestVerdict.scopeWord`),
a designed, not-built screen has no verdict, and the absence word is *no test is known to reach*. Every gate carries a
class and a tier (core `gate-class.ts`: business · policy · technical; `gateTiers` in config or `@guard[tier]` to
override), the business register lists business and policy and folds the rest, and a `@guard` that writes a status is
an action, never a gate on itself; preconditions are read from the code (`parsers/src/preconditions.ts`), never
declared. A lifecycle's words come from `lifecycle.<record>.views` in config and `humanize()`; the statuses and the
moves come from the code. Every `Counted` on the front door carries the `recheck` command that reproduces it.

## Design language ("Farsight HUD")

Blue-black ground `#0A0D14`, panels `#111623`, condensed-uppercase HUD labels (Futura/Avenir Next Condensed), SF Mono for code/data. **Two meaning-bearing accents: quest-amber `#F0B44E` = business lens, signal-cyan `#5BC8DD` = code/hybrid lens** — switching lens warms/cools the chrome. Node kind colors: component green `#6FCF8E`, route cyan, function gold `#D8C27A`, table violet `#C287D6`, guard/auth purple `#A78BE0`, rule/warn `#E8A13C`, package copper `#E39A72` (`--pkg`; a solid stripe for a workspace library, a hatched one for a third-party package, `sym('package')`). Light theme exists (`[data-theme="light"]`). Game vocabulary: quest log = saved flows, fog of war = unindexed, fast travel = ⌘K.

## Current position

**`docs/AI-HANDOFF.md` carries the current state and the ranked next work; `docs/history/` how it got there.**

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
