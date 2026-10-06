# Farsight — shared Codex / Claude memory

**This repo is public.** Client material, session handoffs and review evidence live outside it (a private folder the
owner keeps); never add a client name, a site/org URL, an email, a keychain account name or an absolute home path
here. Examples use `example.atlassian.net`, `dev.azure.com/example-org`, `dev@example.com`,
`keychain:farsight/jira-example` / `keychain:farsight/ado-example`, and *the reference app* for the real application
Farsight was dogfooded on.

## Start here

Read `AGENTS.md` for project rules and architecture. Codex loads it as project instructions; `CLAUDE.md` imports it and this handoff. Keep durable facts in those repository files so both providers receive updates. This is project memory, not ChatGPT account memory or a synchronization of private conversation histories.

Inspect `git status --short --branch` before edits. Preserve existing work; use separate worktrees for simultaneous implementation. At handoff, record the branch, changed files, validation commands/results, and remaining work here. Recheck dated facts against code. Do not assume another provider's authentication, permissions, or MCP session carries over.

## Runtime and commands

The project requires Node 24+ and pnpm 9.0.0. `.nvmrc` selects Node 24; with nvm installed, use `nvm install` once and `nvm use` in each development shell. These commands install/select a runtime only when explicitly run; adding `.nvmrc` does not change an existing shell. Any Node 24 on PATH works.

```sh
nvm use
node --version
pnpm --version
pnpm install --frozen-lockfile     # fresh checkout
pnpm build
pnpm -r typecheck
pnpm -r test
pnpm lint:strings
```

Tests import compiled `dist/`, so build first. A fresh checkout also needs `cp .farsight/settings.example.json .farsight/settings.json` (or nothing — the server falls back to a one-source workspace) and an ingest or `/api/sync` before `serve`/`mcp` have a graph.

## Provider access

- Codex: `.codex/config.toml` configures the workspace CLI over MCP stdio.
- Claude Code: `.mcp.json` configures the same workspace CLI and graph. `.claude/launch.json` defines the viewer on port 4477.
- Both launch `node packages/cli/dist/cli.js mcp --graph graph.json` from this repository root. Select the supported Node runtime in the environment launching the client. Existing desktop clients may retain their older PATH until restarted.
- Both provider configurations have eight corresponding review personas under their respective `agents/` directories (how to run them: `docs/review-swarm.md`).
- After rebuilding, restart running viewer/MCP processes before trusting new behavior. Reload the browser after refreshing the graph.
- Use `node packages/cli/dist/cli.js status` to inspect build/graph/server currency. Do not assume a successful build updated an existing server.
- Preserve the multi-source dogfood graph: use the workspace server's `POST /api/sync` after restart. Bare CLI ingest replaces it and ignores workspace source excludes. Smoke-test ingest from a temporary cwd with an explicit output path instead; SQLite history is cwd-relative too.

Codex project instruction and MCP conventions were checked against [official AGENTS.md documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Current state — 2026-10-06

`main` is green.

| | |
|---|---|
| build | **`0.3.0`** (GitHub Release v0.3.0, 2026-10-04, release PR #43 — close/reopen still needed without a `RELEASE_TOKEN`), workspace main at **`81a455e`** after the swarm-fixes round (PRs #62–#71, item 14 below) on the 2026-10-05 round (#53–#61), the Map clarity pass (#50–#52) and the journey-organisation pass (#45–#49) on top of the map-view, data-stores, map-pass-2 and code-map-performance passes (PRs #8–#42) |
| tests | **1117** — core 333 · work 59 · parsers 205 · work-fixture 18 · work-azdo 39 · work-jira 41 · mcp 56 · server 306 · cli 60 (+ `pnpm test:scripts` 13), 0 failed, 2 skipped (the live tracker tests, opt-in with `FARSIGHT_LIVE=1`) · **e2e 239/239** (the `codemap-projects`, `codemap-toolbar` and `settings-config` specs start their own two-source server; `journeys-organised`, `map-journey-links` and the small perf preset run in CI; `pnpm e2e:perf` is the full thousand-project table, on demand; the suite is timing-sensitive on a loaded machine — see the swarm-fixes left-open list) |
| string/symbol lint | **2240 entries · 35 sprite symbols · 49 modules**; the define test bans backticks, markdown, unfilled placeholders and catalog keys; a catalog module per area (`strings-gate.ts`, `strings-chrome.ts`, `strings-lifecycle.ts`, `strings-export.ts`, …) registered like `strings-doors.ts` |
| servers | the dogfood server on **4478** (workspace CLI, `flags.map` on in the local settings) and the reference app's own `farsight` on **4477** (the global install under the Node 22 prefix, started from that workspace, `flags.map` on in its local settings). Both restarted on `81a455e` on 2026-10-06 and re-synced through `POST /api/sync` (4478 sync 66, 4477 sync 107 — its status line now reads *history 282 commits indexed · 0 new this sync*); both prefixes' global `farsight` print `commit 81a455e`; zero page errors on the Map storyline, the front door, a branch journey, Tests and Settings of 4477. The reference app's own manifest declares two personas, six groups, placements on all 18 flows, two storylines and the correction journey as a **branch** of review; its design drift is **7**. For a reviewer swarm, restart 4477 with `--read-only`. Check `lsof` before restarting or measuring on any port. |
| runtime | Node 24 is under nvm (`nvm use 24`); the shell default is still 22 for the 4477 server, so every build/test shell runs `nvm use` first |
| trackers | a Jira test site and an Azure DevOps org, both reachable live on 2026-09-30 from a probe that reads the keychain in-process and prints only the outcome. Their names, accounts and credentials are kept outside the repo. |

**Live tracker tests** run only with `FARSIGHT_LIVE=1` and read their target from the environment:
`FARSIGHT_JIRA_SITE` / `FARSIGHT_JIRA_USER` / `FARSIGHT_JIRA_KEYCHAIN` and `FARSIGHT_ADO_ORG` /
`FARSIGHT_ADO_PROJECT` / `FARSIGHT_ADO_KEYCHAIN`. The defaults are the example values above, so without the env they
skip with a reason. The Jira test writes one comment and one label on the test site; the ADO test only runs
`validateOnly` dry runs. The recorded fixtures under `packages/work-jira/test/fixtures/` and
`packages/work-azdo/test/fixtures/example-org/` were recorded live and then re-synthesized with placeholder names,
ids, titles and bodies; the shapes are as recorded. A re-recording must be scrubbed the same way before it is committed.

## What shipped most recently

1. **The clarity phase** (2026-09-21 → 09-24): one count vocabulary and one denominator, evidence classes, deferred /
   setup edges, externals, interface-typed dispatch, Journeys as the front door — 56 chunks, measured on the
   reference app.
2. **The viewer usability pass + the visual swarm and its four fix lanes** (2026-09-24).
3. **MCP currency, e2e, fast travel, component stories** (2026-09-25). The header stays live while a journey is
   open; MCP reaches gates-vs-rules, per-node unit/e2e coverage, impact-tests, change history (`graph_changes`) and
   stories; Farsight has a Playwright e2e suite on the real server (**no MSW — ADR 8**) whose results appear in its
   own graph; ⌘K arrives somewhere visible; `farsight status` stops crying wolf on same-code builds; components
   embed their **live Storybook stories** (ADR 9). The pass swarm scored **6.3, 6× TRIAL**: nobody hit the header
   bug, stories were the best-received feature, and **one number, one scope** became the top complaint.
4. **Tooltips, one number one scope, and the business register's last code words** (2026-09-25, second pass).
   A tooltip primitive (`lib/tooltip.js`: click, 2 s hover, `?`; simple tips from the catalog's define, rich tips
   with tables and links; `numberTip()` = counts · over · from · breakdown · Grammar Book); a counts ledger
   (`docs/COUNTS.md`) reconciling every reviewer contradiction on the reference app's graph into typed `Counted`s
   from core; identifier tokens in the business register went to **0** on every view, held there by e2e specs; ⌘K
   matches identifiers in every register and shows business names. The **story swarm** (all eight personas) then
   asked *do I understand the reference app?* — mean **6.9, 8× TRIAL**; the weak answer is *where to go next* (1.9).
5. **The next-step story, first pass — evidence that agrees with itself** (2026-09-27): a passed declared e2e case
   is observed by its own declaration; one absence word per fact; defines in words; scripts are tooling; the glossary
   meets class members; five small fixes (drift tip, impact counts each test once, ⌘K arrives on the thing picked,
   RESTART compares builds).
6. **Work items as a source — Jira and Azure DevOps, live** (2026-09-30, six lanes, build `d6dace1`).
   Proposal `docs/proposals/work-items-sync.md` P0–P4 in one pass, centred on *what work changed what code*:
   - **`packages/work`** — `farsight-work v1` (frozen, `schemas/farsight-work-v1.schema.json`, enum-pin test), secrets
     resolved **in-process from the keychain** (`keychain:farsight/<provider>-<instance>`, never printed), the `work.db`
     cache (replace-never-merge items, SCD2 revisions, links, outbox, audit), the sync engine (cursor, hydrate, periodic
     reconcile, cached schema, freshness facts), the **three-verdict gate** (policy · tracker · credential, plus a dry run
     beside them when the provider has one; default deny; agents confirm through a person), the key detector (Jira
     `KEY-1` / `#KEY-1` / `[KEY-1]` / `…/browse/KEY-1`, ADO `AB#4711` / `#4711` / `_workitems/edit/4711`, branch names;
     only keys of a configured source's projects count — `INV-01` screen names never do), `farsight work
     sync|status|list|show|links|comment|assign|move|edit|link`. **`packages/work-fixture`** is the CI provider.
   - **`packages/work-jira`** (api-token, discover by `schema.custom`, `search/jql` + changelog bulkfetch + comments,
     ADF ↔ markdown, compare-before-write) and **`packages/work-azdo`** (PAT / az-cli, discover with state categories per
     type — *Resolved* stays in-progress, a state the type does not define is said so — WIQL + batch, the reporting
     revisions feed, comments on 7.2-preview, HTML ↔ markdown, `test /rev`, `validateOnly` dry runs). Both verified
     **live**: Jira 14 items, incremental after an edit, a comment through the gate, a conflict caught; ADO 4 items
     with history and comments, second sync via the feed, nothing changed on the org.
   - **In the graph** — `work` nodes, `tracks` edges, the `work-key` technique (enum pins and schemas grown by one member
     each); every sync indexes the **commit spine** (500 commits, incremental) with message bodies, branches whose names
     carry a key, and the keys themselves (`commit_key`, `commit_branch`, `commit_node`); a commit is credited to the
     function its changed lines start in; a `@work` doc tag joins `@covers`; settings `type: 'work'` sources are pulled by
     `/api/sync`; the `/api/work*` routes (list, item with links/commits/touched/findings/allowed/preview, `diff?sha=`,
     links-by-node, by-flow, sync, intent with dryRun/confirm/drop/rebase, outbox with `theirs`, audit, people, states;
     503 without sqlite).
   - **The HUD** — a WORK tab (*Bounty Board* / *Work*): source cards with mode, freshness sentence and capabilities in
     words; list/board/sources views; the item pane with assign, move to, comment, title and description under the gate
     (applied · waiting for your confirmation · conflict with both sides · denied with three verdicts); *what this work
     changed* — commits with how the key was found, files, the unified diff per file with the touched parts as chips, a
     *touched* count and *see what uses these*; findings (*done but its screen is not built*, *to do but N commits name
     it*); chips on Portfolio and journey headers; ⌘K travels to work nodes. **MCP** — `work_items` (json = the frozen
     list), `work_item`, `work_links`, `work_changes`, `work_sync`, and `work_comment|assign|transition|edit|label|link`
     **registered only when a source grants agents the action**; `graph_overview` gains a work-items section.
7. **The Map view — Neighbourhood · Street · Property** (2026-10-03, proposal `docs/proposals/map-view.md`, prototype
   `prototypes/map-view/`, two lanes plus two follow-ups each, PRs #8–#13). A flag-gated surface (`flags.map`,
   Settings → Experiments; a *Map* door on the Portfolio and a nav tab when on) that draws the journeys as one
   whiteboard with three altitudes: **neighbourhood** — every journey as a district in bands by source, row-packed,
   covers counter-scaled so names read at the fit, *leads to* / *requires* dimmed and *part of* on hover;
   **street** — one journey's screens in step order with a lean chip row, and with plumbing on (`p`) a **pathway per
   screen**: its calls stacked with a service colour bar (the spec title), beside each call the records, messages and
   third parties it reads (cool) or writes (warm), folds past four calls or four data nodes, declared-not-called and
   not-built drawn dashed; **property** — the screenshot whole as the hero (letterboxed, lightbox on click), a rail
   of eight tabs with the summary's own counts (Overview · Gates & rules · APIs · UX · Tests · Route · Work · Changes),
   clamped text, capped lists, a step bar with before / after / also-in, and a deterministic placeholder for a screen
   without a picture. Pan, pinch, ⌘-scroll and keys; snap into a screen past ×1.6 near the centre; one explore card
   for calls and data nodes. Everything reads `/api/design` and `/api/journey` (no server change; `lib/map-model.js`
   and `lib/map-property-model.js` are pure and unit-tested); every number is a `Counted` with a tip (`docs/COUNTS.md`
   § Map); ADR 10 (DOM in a transformed world, not a canvas). Verified on the fixture and, read-only, on the dogfood
   graph (21 journeys, a screen with 10 calls and 273 cases): zero page errors. What the real graph still shows:
   *leads to* curves cross between bands; names fall under 12 px past ~30 journeys at the cap; per-screen work chips
   are not fetched; the explore card has no Impact yet.
8. **Data stores — which store a record lives in, and externals the app uses as stores** (2026-10-03, later the same
   day; proposal `docs/proposals/data-stores.md`, PRs #15–#18). `GraphNode.store: StoreRef { name, kind: sql · document
   · files · erp · other, engine?, via: factory · sdk · datasource · jpa · config, ref? }` on table nodes and on
   store-like externals (`erp`, `db`, `files` by default; `ExternalDecl.store` overrides); rules in that order, never a
   guess (two SQL drivers → no store, with a note in `meta.stores`); `farsight.config.json` `stores[]` fills what code
   left unnamed and never overrides it. A declared client class gets **one `http` edge per public method** with
   `meta.method` from the literal on the path to `fetch`; `fetchMethod` no longer defaults to GET for a non-literal.
   **Fetch wrappers** (`apiFetch(path, init)`, two levels deep) resolve to their callers' paths and literal methods;
   an unknown method on a path served by several routes takes the GET route with `meta.methodAssumed` (MEDIUM, the
   seam card says *method assumed*, candidates recorded) instead of a stub. Journey markers carry `op` for externals
   (GET/HEAD reads, POST/PUT/PATCH/DELETE writes, else none) and `store`; `system.stores[]` and `counted.stores` are
   new. The map's street prints `<store> · record` / `<store> · ERP`, bars by store kind, `reached` (new mode, plain
   dim line) when no direction was recorded, stores in the legend, the store on the explore card, and the property's
   *Data this screen reaches* grouped by store; `describe_node` prints the store line. Measured on the reference app
   (read-only, in a scratchpad): all 21 tables named Postgres from the `pg` driver, the ERP an `erp` store with 14
   edges split GET · POST · PATCH · DELETE, Blob Storage a `files` store; http edges to routes 61 → 69, unknown
   stubs 3 → 3 (a mid-pass regression to 49 / 9 was caught by that measurement and fixed in #18). Row keys and table
   ids are unchanged; the fixture graph is byte-identical apart from its `stores` config.

9. **Map pass 2 — the swarm's findings, blast radius, dependencies and NX** (2026-10-03 → 10-04; proposals
   `docs/proposals/map-pass-2026-10-03.md` and `docs/proposals/dependencies-and-nx.md`; eight lanes, PRs #20–#30).
   From the eight-persona swarm on the Map (8 × TRIAL, fit 6.25, six of eight would open the Map first; reports
   outside the repo): **Z** — the canvas engine normalises every input (a mouse notch, a trackpad step, a pinch and
   the keys all take the same 1.25× step), zoom has soft **stops** (board · journey fitted · calls readable, the last
   computed from an 11 px label), zoom-to-enter is *earned* (armed only past the calls stop, fired only when one
   screen is centred and ≥ 60 % of the stage, after a visible hint), Fit fits the level you are on, a journey opens
   centred under the toolbar with `▸ n more` edge cues, the toolbar is opaque, tips open on hover
   (`lib/map-canvas.js` exposes `attachCanvas()` for the code map to adopt); **N** — one number with its scope:
   `14 screens · 10 reached` with `screensReached` typed in core, the footer `screen 4 of 10 reached`, the evidence
   word beside every tests count, owner and ERP reach on the cover, the Tests page vs code-map chip difference named
   (`1429 cases · 10 coverage reports`), the Changes tab reading the commit spine for the screen's parts
   (`GET /api/history/touching`); **L** — a legend (`?`), links routed square through the gaps with one label each,
   wider columns so nothing truncates, chips that wrap then fold to `+n`, the business lens finished on data nodes
   (*Postgres · database record*) and gates (*check* / *rule*), Portfolio's switch reads TABLE · BOARD; **K** — Tab
   reaches every journey, screen, call and data node, Enter/Esc/`j k h l`/arrows, `⌘K` arrives on the Map, the link
   carries the view (`?z&x&y` as the view's centre in world units) and the open card, `y` / *Copy link*, an *as of*
   stamp; **I** — the **Affected mode**: `?affected=<node|package:|work:KEY|commit:sha>&ahops=N` from the explore
   card, the property head and the Work/Changes rows; districts, screens, calls and data dim or carry hop badges at
   every altitude; an *Affected* tab with four typed `Counted`s from core `affectedReach` (journeys · screens · calls ·
   tests, partitioned by distance, scope `count.scope.affected`), the floor line and the cut points;
   `GET /api/impact?reach=1`, `GET /api/history/commit?sha=`; **D** — **dependencies**: `package` nodes (third-party
   and workspace, versions from the nearest manifest, `imports` edges with specifier and line, `module` nodes kept out
   of search), `GET /api/deps` and `/deps/where`, `farsight deps list|where`, a package is an impact seed, the
   tsconfig-paths comment bug fixed (star aliases now resolve); **X** — **NX projects and tags**: `GraphNode.project`
   on every node under a project root, `meta.projects` (tool nx · workspaces · none, tag dimensions `scope:` → domain,
   `type:` → type, configurable in `farsight.config.json projects`), a project graph with project → project import
   counts, `GET /api/projects[/<name>]`, `examples/nx-workspace/` (2 apps, 5 libs, an e2e, two journeys); **C** —
   the **code map by project and package**: GROUP by project / domain / type, scope filters incl. *depends on*,
   package cards in copper, *App and its related* and *Where is <package> included* views (`?view=app&project=` ·
   `?view=package&package=`), inspector sections for project and package, the Map's *Band by: source · domain*.
   Measured read-only on the reference app: 21 NX projects (3 apps · 17 libs · 1 e2e) all tagged, 32 packages (17
   workspace, each tied to its project), ERP store seed reaches 12 of 18 journeys, the busiest table 17 of 18 and 45
   screens, zero page errors. Dependabot's three alerts (example manifests) cleared in #30.
   **Swarm round 2** (2026-10-04, same eight personas on the merged pass, reports outside the repo): 8 × TRIAL, fit
   6.25 → 6.5; Map 6.8 → 7.0 · Journeys 6.75 · Portfolio 6.4 · Code map 3.9 → 4.9; the journey-level numbers now
   agree across views for every persona, the blast radius is credited by every role, *Where is a package included*
   was called the best panel in the product. One **regression** found by all eight: the Map takes the journey
   nearest the viewport centre, not the one clicked (a wide journey opened at its fitted-width floor loses to its
   neighbour) — fixed in PR #32 together with the Affected mode's readability at board altitude (fit-to-
   affected, a list with CSV/JSON), scope words on per-journey counts, the legend covering the toolbar, the zoom
   anchor and first-notch tooltip, the stepper's feedback, Enter/`?`/`y`, pan bounds, and the code map's spec-file
   boxes. **The project picker** (PR #34): `lib/multi-pick.js` (+ a pure, tested `multi-pick-model.js`) — a searchable
   multi-select grouped Applications → Libraries → End-to-end → Other with type and tag words, keyboard and ARIA, chips
   that fold past six; used by the scope menu's Projects / Tags / Depends-on, the Views menu's two pickers (single),
   and ⌘K (projects match, applications first, arriving `?group=project&box=<name>`); project and tag filters now
   ride in the link (`?project=`, `?tag=`) and in localStorage.
10. **The code map's performance pass — one precomputed index, set algebra, the project graph folded once**
    (2026-10-04, PRs #39–#40). The defect: the code map grouped by project or by a tag dimension hung the page for
    minutes on the dogfood graph (21,175 nodes) — `cmapHide(n)` ran once per node and, grouped, called the GROUP-choices
    fold over every node each time (≈7 ms × 21k × 2 passes ≈ 280 s per draw); card heights, rule badges and the
    inspector also scanned every edge per card. **Measured on the live dogfood server, before → after:** ungrouped
    2.2 s → 1.1 s; grouped by project *did not draw in 90 s* → **0.8 s**; a two-project filter and the app view ≈ 0.3 s
    (the lane's measurement); zero page errors. **Viewer:** `lib/codemap-model.js` `buildCodemapIndex` (one pass over
    nodes, one over edges: node → project key, project → nodes, dimension → value → projects, package → importers,
    `validates` counts, test files, repo → projects), `groupChoicesFor` (O(projects)), `passFor` (a filter is set
    algebra — projects ∪, tag values ∪ per dimension then ∩ across dimensions and with the project filter and the app
    closure, packages kept via their importers, `dep` ∩), `groupKeyOf` (O(1)), `projectClosure` (the app's tree from
    `meta.projects` so *App and its related* draws at once); one index per graph object and the choices cached per
    graph + scope; `store.js indexGuards()` also builds `S.validatesByTarget` and `S.EDGES_OF`, so `select()`,
    `itemHeight()` and `nodeCardHtml()` look up instead of scanning. A **Projects** chip in the code map toolbar
    (`Projects · n` when picked) opens kind chips (Applications · Libraries · End-to-end · Other), the same searchable
    multi-select as the scope menu (one filter, one `?project=`), and *Focus on an application* — the app view, drawn
    from the page's graph first and labelled when the server answers. A regression guard: `codemap-perf.test.ts`
    (a synthetic 20k-node graph, the index + choices + two filters + the fold under 2 s; `passFor` proven equal to the
    old per-node predicate on the NX example + invoice app). **Core/server:** `projectGraph()` is folded once per
    `GraphIndex` (a `WeakMap`, refolded when the index or `meta.projects` changes; `?repo=` narrows the kept rows),
    closures walk an adjacency built once and are remembered, every `ProjectRow` carries `closure: string[]`,
    `/api/projects/<name>` is a lookup (`projectNodeIds`). `/api/projects` on the dogfood graph: 15 ms first, under 1 ms
    after. **NX's own project graph is read, never produced** (`parsers/src/shared/nx-graph.ts`): for an NX source the
    first of `.nx/workspace-data/project-graph.json`, `.nx/cache/project-graph.json`, `node_modules/.cache/nx/project-graph.json`
    or the file `farsight.config.json → projects.graphFile` names (source-relative; absolute, `..`, NUL, a symlink out of
    the source, a non-file or > 20 MB each refused with a note; both the `nx graph --file` and the bare cache shapes;
    `npm:` targets skipped; only names discovery found count, the rest a count in `notes`; nothing is ever spawned —
    `docs/SECURITY.md` says so). Recorded as `meta.projects.dependencies` (`via: 'nx-graph'`) and `graphFile`; a project
    no manifest typed takes NX's type; in the project graph a pair NX records gets `nx: true` + `nxType`, a pair only NX
    knows is a dependency with `imports: 0` under the new part `count.part.depsNxGraph`; `graph_overview` prints
    `nx graph: N dependencies read`. Imports read from the files stay the primary evidence (principle 2).

11. **Journeys organised by persona and group, and many config files per source** (2026-10-04 evening; proposal
    `docs/proposals/journey-organisation-and-config-files.md`, PRs #45–#48, three lanes). Four decisions taken with the
    owner: the manifest declares and a config block overrides; a nested config scopes its own folder; two fixed levels
    (persona → group → journeys); MCP reads and guides, never writes into a source.
    - **Config files** (#46): every `farsight.config.json` in a source is read (`parsers/src/shared/config-files.ts`
      `loadWorkspaceConfig`, root first, then by folder depth; the workspace excludes apply). A nested file's node
      matchers (`tags`, `glossary`, `guards`, `entrypoints`, `setup`) apply only to nodes under its folder and
      the nearer file's word wins; its paths (`plumbing`, `design`, `openapi`, `tests` reports, `storybook`, a
      `path::Class` external import) are rebased to the source root and unioned; `tests.unit|integration|e2e` take
      one block or a list and `results|coverage|report` take one glob or a list; `externals`/`stores` union with a
      duplicate recorded as a conflict; `projects` and `tooling` are root-only (a nested value is a note). The six
      readers consume one `WorkspaceConfig` and all honour `config: false`. `fragment.meta.config: ConfigMeta`
      (files · conflicts · notes) → `meta.config[repo]`; MCP `config_files` and a `graph_overview` line, `farsight
      config list`, `GET /api/config`. `examples/nx-workspace` has two nested configs and one deliberate glossary
      conflict.
    - **The model** (#47): `screens.json` gains `personas[]` and `groups[]` (ordered; a group with `persona` lives
      under that persona only), a flow gains `persona: string | string[]`, `group`, `order`; order is `order`, then
      the config's index, then **manifest order** (the alphabetical sort is gone on purpose; the pinned *start here*
      stays marked, not moved). A `farsight.config.json → journeys` block (`personas`, `groups`, `flows` by id)
      overrides field by field, root block first and the nearest nested block last; an id no manifest declares is a
      note. Folded at ingest into `meta.journeys[repo]` (`core/journeys.ts journeysMetaOf`); `journeyTree(index,
      metas, scope)` is the one pure fold behind `GET /api/journeys`, MCP `journeys { repo, persona, group, json }`,
      `farsight journeys`, and the `graph_overview` journeys line; the `journey` tool prints *shown under*. An
      undeclared persona string (the reference app's *"X and Y"*) is its own persona, flagged *not declared*, never
      split. Every count is a `Counted` (`docs/COUNTS.md` § Journeys). `design_guide` documents all of it, nested
      config files included. A multi-manifest fix: an earlier manifest no longer marks a later manifest's page *built,
      not designed*.
    - **The viewer** (#48): the Journeys front door shows *Journeys by who uses them* — persona heading with its
      description and counts, collapsible groups in declared order (remembered per group), the journey cards, an *also
      for …* chip, `?persona=` / `?group=` filters; the journey header reads *For <persona> · <group>*; the Portfolio
      is one table per persona → group with a pin per persona; the Map bands by **persona** (a journey under two
      personas draws its street once and a dashed *echo* card in the other band). `lib/journeys-tree.js` reads
      `/api/journeys` first and `lib/journeys-model.js treeFrom()` folds the same tree from `/api/design` against an
      older server (proven equal to `journeyTree()` by test). Verified on the dogfood server: 21 journeys · 5 personas
      · 6 groups, zero page errors on the front door, the Portfolio and the Map.

12. **The Map clarity pass — the board draws by altitude** (2026-10-04, late; PR #50, one lane, from the owner's
    verdict *"the map looks a bit crowded"* and the lead's screenshot review of the live board). At **board** altitude
    a journey is a **card**: its name, one status chip (*built* · *partly built · n of m* · *designed, not built*), an
    *at risk* mark (stale and/or not every screen built — the AT RISK bar's own facts) and `→ n` (how many journeys it
    leads to); the description and the full chip row live in the street head, from the journey altitude up. Cards are
    2–4 screens wide and one height (`lib/map-model.js boardWidth()`), so **a cover no longer shares a width with its
    street** — the board has its own layout and `ensureAlt()` swaps layouts at the level change keeping the journey
    under the pointer fixed. Links at the board draw only for the hovered or focused journey (both ends lit, the rest
    dimmed, no labels); from the journey altitude up they draw as before. Each band is a faint **panel** as wide as the
    widest row with a counter-scaled header (the band word · *n journeys* · a persona's description). The toolbar folds:
    *Band by* is one segmented control (a menu under 1500 px), the as-of stamp hides and the level buttons shorten under
    1360 px. Also fixed: `+` / ⌘-scroll from the fit did nothing while the AT RISK headline showed (`boardScale()`
    ignored its row). **Measured on a copy of the dogfood graph (21 journeys):** the board fits at ×0.21 at 1440×1000
    (was ×0.12) and ×0.14 at 1280×720 (was ×0.08), every chip readable, zero page errors on 44 shots. Then PR #51: a
    closed journey blurs the focus it still held at once (a hidden control kept it for a frame) and the focus spec polls.

13. **The 2026-10-05 round — storylines, the Map and the journey as one, details that link out, a thousand projects**
    (proposal `docs/proposals/round-2026-10-05.md`, PR #53; five lanes, PRs #54–#58). From the owner's asks: unify the
    Map and the journey, make every detail click to expand or link, track "verticals" across features, another browser
    performance round for hundreds to 1000+ NX projects, and the handoff's ranked list.
    - **The fetch-helper regression** (#54): `fetch(url, helper(ctx, { method: 'POST' }))` keeps the literal from the
      helper call's object-literal arguments (spreads, one nested call deep), a verb-named helper (`post`·`put`·`patch`·
      `del`) is the fallback, a non-verb helper with no literal stays `methodAssumed`; wrappers pass it through.
      Measured read-only on the reference app: drift **19 → 7**, http edges to routes 69 (literal methods 9 → 69,
      assumed 11 → 0), unknown stubs 3; the invoice-app example's edges byte-identical.
    - **Config follow-ups** (#55): nested `stores[]` scope to their folder (a listing beats a catch-all, then the nearer
      file; conflicts recorded as kind `store`); a read-only **Config files** list on the Settings page
      (`surfaces/settings-config.js` over `/api/config`, which now carries `counts`); `schemas/farsight-config.schema.json`
      and `schemas/farsight-design.schema.json` (2020-12, hand-written, pinned by a test that validates every example and
      checks the config schema's keys equal `CONFIG_FIELDS`); the nx example has four config files.
    - **Storylines** (#56): the word for the owner's *verticals* — a named chain of journeys across features, declared in a
      manifest's `storylines[]` or `farsight.config.json → journeys.storylines[]` (`{ id, name, description?, journeys[] }`,
      the same override rule as personas and groups; an undeclared journey id is a note; a journey may be in several);
      `JourneysMeta.storylines`, `JourneyTree.storylines[]` with `Counted`s (`count.unit.storylines`, `count.scope.storyline`),
      `JourneyRow.storylines`; MCP `journeys { storyline }`, `graph_overview` counts them, the `journey` tool prints *in
      storyline · step n of m*; `farsight journeys --storyline`. On the **Map** a *Storyline* picker (`?storyline=<id>`):
      the board draws only that chain **as one band in order**, step numbers on the cards, a *then* link between steps at
      every altitude; *All* restores the bands. Persona bands now start each **group on its own row with the group word
      in a gutter**. The front door has a *Storylines* section (numbered status chips, *open on the Map*, *open the first
      journey*); the journey header reads ‹ storyline · step n of m ›. The business register says *questline* and
      *journey n of m*.
    - **The Map and the journey as one, and every detail a door** (#57): `#/journeys/<flow>?view=timeline&step=n[&node=id]`
      opens the blueprint timeline at step n with that marker selected; `#/map/<flow>?screen=n[&plumb=1&card=<kind>:<id>]`
      frames the screen and opens the explore card — two pure, tested functions in `lib/route-url.js`; *see it on the Map*
      in the journey header, *open the journey here* on street screens, the property head and the explore card; the
      journey writes `step`/`node` into the address as the selection moves. `lib/detail-links.js detailLinks(kind, node,
      ctx)` (lookups only, 0.7 µs each) is the one door builder: gates and rules → *open in the editor* (VS Code at the
      line, code read from the new read-only `GET /api/source?node=`) · *see it on the code map*; route calls → *read the
      contract* (`#/apis/<id>?op=`) · *read the spec file* · *open the handler in the editor*; records/stores/externals →
      code map · schema file; tests → *see the cases* (`#/tests?flow=`) · the test file; work → the work board · the
      tracker; screens → the page · the manifest · Figma; packages → *where is it included*. A door the graph cannot name is
      not drawn; the business register drops every door into code. Journey gate rows expand in place to their code lines
      and doors; Enter opens a focused detail's first door, `o` the editor. Board cards now show *stale* (muted) and *not
      built* (amber) as two marks, and an 8-px reading floor (*n journeys · zoom in to read*).
    - **A thousand projects** (#58): `scripts/synth-graph.mjs` (seeded; full = 1,000 projects over 20 sources, 244,880
      nodes, 417,836 edges, 300 journeys in 40 manifests; `--preset small` for CI), `e2e/perf/` + `pnpm e2e:perf` printing
      one table, `packages/server/test/thousand-perf.test.ts` holding the folds under budget. **Before → after on the full
      preset (ms):** front door 428 → 217, persona filter 373 → 60; Map board 465 → 236, open a street 195 → 125 with heap
      1252 → 753 MB, pan/zoom 52 fps; code map grouped by project *did not draw in 120 s* → 421, a filter → 371; Portfolio
      368 → 154; APIs 348 → 140; Tests 9113 → 252; Changes 338 → 131; Work 351 → 133; ⌘K keystroke 587 → 45. How: the code
      map builds only the cards near the viewport past 1,500 drawables and reads every height before writing; the status
      bar's 245k-node scan, each node's group and the tag-chip counts are computed once per graph/scope; ⌘K matches over
      text prepared once in idle time (`lib/search-model.js`, ranking proven equal to the old scan) and re-ranks a growing
      query; `routeLinks` blocks only each district's own crossings; server `folds.ts` keeps answers per index (the
      Portfolio rebuilt the 7 s tests catalogue 300×), `/api/tests?lean=1` (the full answer is 243 MB at this size),
      `/api/journey?steps=0`; core coverage looks up a journey's nodes instead of scanning all (`testsSurface` 7.9 → 2.1 s).
      **The ceiling that remains is the payload:** `/graph` is **411 MB** at this size (2.4–2.8 s to load, ~500 MB heap,
      ~2 s server parse) — the server-side query API round.

14. **The swarm-fixes round — the 2026-10-05 swarm's nine findings, in its order** (2026-10-06; proposal
    `docs/proposals/swarm-fixes-2026-10-05.md`, PR #62; eight lanes, PRs #63–#71, every lane measured on a read-only copy
    of the reference app's graph served by its own build, zero page errors on every shot).
    - **One test verdict per cell** (#64): the contradictions were two extra folds, not the word — the *their own last
      run* line printed the weakest status over every covering case (one skipped case among 145 said *skipped*) and
      the tip's verdict folded over coverage reports, which record `unknown`. Core `testVerdict()` now puts `verdict`
      on every coverage fold: the word is `evidenceWord` as before, `status` is read only over the refs that earned the
      word (a declaration word only ever stands beside *passed*; a coverage report alone gives no status), `runs` is
      every case by its own last run (passed · failed · skipped · flaky · no run recorded, summing to the cases).
      A route and its handler at the same `file:line` are twins (`sameLocTwins`), so `route.ts:24` carries one verdict on
      both surfaces. Every scoped foot has *open the list* and the Tests page reads `?flow=&seg=&action=` /
      `?node=` (`GET /api/tests?flow=&seg=[&action=]`, `cases` opt-in); `farsight tests matrix` gains the runs column.
    - **Stale said once and only when true** (#65): on the reference app *stale* is **true** — the Playwright run was
      stamped on 2026-10-04 and the code moved after it — so the counts barely moved; what changed is that every
      *stale* carries both sides (`core/freshness.ts` → `freshness` on every coverage fact: *the tests ran on commit X
      (date); the code is at commit Y now*, or *the working tree changed after the run*), a current scope says
      *current as of sync N*, and a run with no digest says *no source digest* with the stamp recipe, never *stale*.
      The code side is `meta.tests[repo].head` (`setFreshnessMeta` per index in server/MCP/CLI). The Tests page is one
      card per source × level × runner (the reference app's e2e level is a Playwright card and a Vitest card, each
      with one answer). **Settings vs Changes:** `writeSpine()` printed only this sync's incremental read (`history 0
      commits read`); it now prints `history N commits indexed · k new this sync` from `db.commitCount`, the rows
      Changes counts.
    - **One word per position, and the business register's last words** (#70): *step* is the storyline position
      only (business *journey n of m*); the Sheet's columns are **stops** (`counted.actionStops` = actions + run again
      + declared only + nothing to call — pinned by a core test, which is why *5 actions* and *6 columns* were both
      right), the drawer head says *stop n of m · call*, the drill's *stop* and *beat* stay, the code register's
      *983 steps* is *visits*, inspector words say *part*, plurals come from the catalog. Business register: gate
      shapes are sentences (`journey.biz.gateShape.*`), `chore(memory):` prefixes drop from commit subjects, a store
      read off a driver prints *database record*, plan ids drop, descriptions go through `plainWords`; ADR numbers
      stay in every register as citations. Identifier tokens in view on the walked business screens 375 → ~199
      whole-page, 0 on the storyboard, the storyline board and the Map street.
    - **A gate answers its click** (#67): one gate card everywhere (journey lists, Sheet, ladder, drill, Map property,
      code map inspector; `lib/gate-card.js` + a pure `gate-card-model.js`, `GET /api/gate?node=`, MCP `gate`, a
      `## gate` section in `describe_node`): kind · name · `path:line` · doors on its head · *what it allows* (the
      `@business` sentence, else the `@guard` words, else *nobody has written down what this allows* with who should and
      where) · *where it stands* (n of m calls · n pages) · its code wrapped · the calls it guards with doors · the
      tests that reach it with the one verdict; business keeps sentence, scope and tests. The doors are on every gate
      row; the ▸ fold is gone. **Config checks** (core `config-check.ts`: a guard whose text reads the environment and
      takes no request-like parameter; six of the reference app's 73) are listed and counted apart and never as a
      screen's gates — the ops sign-in checks were reached from the page's `serverContext` → `loadWebEnv`, not from a
      call; the submit journey went 28 → 25 gates & rules + 3 config checks. Two CI-only races fixed on the way: the
      card survives the inspector redrawing under it (a `data-tip-anchor` the tooltip re-finds), and the specs click
      the gate's name, not the row's centre (Linux font metrics put the centre on the ⧉ editor link).
    - **Chrome** (#66, plus the focus fix #71): a cog with the word SETTINGS and a Settings row in ⋯; **READ-ONLY was a
      constant chip with nothing behind it** — now `farsight serve --read-only` (and every `--as-of` serve) refuses
      `PUT /api/settings`, `POST /api/sync`, `POST /api/work/*` (`guard.ts` `isWriteRoute`/`refuseWrite`),
      `/api/version` reports `session: { readOnly, why }`, the chip shows only then and every `[data-write]` control is
      greyed with a tip; the legend is closed by default, scrolls inside itself, has its own glyph and the `g` key; `?`
      opens the keymap everywhere; the Map toolbar folds by measurement (the 1440 overflow was its fixed breakpoints);
      the Sheet's *verified by* chip wraps inside its cell and gate names break between words; Experiments is one flag
      per line; the chosen journey view is remembered per register so business lands on the Storyboard; Esc on an
      empty journey asks first; the board takes focus when the Map opens and Tab from it goes to the first cover (the
      band header's count was redrawn by the first walk — the flaky spec's cause); the light theme dims less.
    - **Storylines, second pass** (#68): a **branch** is a storyline fact — a `journeys[]` entry
      `{ id, branchOf, when, rejoins? }` in the manifest or the config override (`branchOf` a step of the same storyline,
      `when` required, `rejoins` absent when the case leaves the storyline); the Map draws it on its own row under its
      parent, dashed with a fork glyph, the condition on an amber link and a dashed return; the front door lists it
      indented with *back to …*; the journey header reads *branch of … · when …*; MCP/CLI print it; counts break
      down *n on the main path · n branches*; both JSON schemas and `design_guide` cover it. `?storyline=<unknown>`
      says so with the declared ids as doors (`#/journeys?storyline=` and MCP/CLI too); ⌘K finds storylines (first
      row, lands on `#/map?storyline=`); storyline cards on the Map and the front door carry the first journey's first
      screen or the placeholder; each board card carries the one evidence chip and the band header *n of m journeys
      with a run's evidence*. The reference app's manifest now declares the correction journey as a branch of review.
    - **The two empty screens, and the record's status lifecycle from code** (#69): the mark-paid state screen is bound
      to a form that only runs `onConfirm`, a function its parent handed it — the call was credited to the page
      component alone, so the street (same edges) listed it under the page and the state screen had nothing to walk
      into; the approval state is bound to a display-only component. New parser pass `callback-props.ts`: a component
      that runs a function its parent handed it gets `calls` edges for what that function calls, following
      pass-through parents, only along components rendered from one place (technique `callback-prop`, MEDIUM, added
      to the frozen diff schema additively); a parent-computed value is credited only where the child branches on it.
      On the reference app five state screens went from 0 calls · 0 gates to their call, 8–12 gates and 40–65 cases;
      http edges to routes 69 → 69, unknown stubs 3 → 3, drift 7 → 7. **Lifecycle:** `GraphNode.lifecycle` on a record
      when the code declares its statuses (a SQL CHECK, `z.enum`, a literal union, a `const … as const`) — statuses,
      transitions with the writer that performs each (`from` only when the writer compared the prior status),
      statuses no code writes — as `Counted`s (core `lifecycle.ts`), printed by `describe_node`, as a strip in the
      journey header and the Map property's Overview with a door per move. The reference app's invoice: 11 statuses,
      6 moves with a writer (draft → submitted → verified → approved → compiled → scheduled → paid), 5 nothing writes;
      the storyline's order matches the moves.
    - **Export** (#63): *Save* in the Map toolbar, the journey header and the Portfolio heading — PNG (the DOM copied
      into an SVG `foreignObject` with the page's stylesheet, same-origin images and sprite glyphs inlined, drawn to a
      canvas at ≥2×, empty rows cropped) and PDF (a minimal writer embedding the canvas; long side capped at A3), CSV
      for the Portfolio; a three-line provenance footer (what it shows · source · sync · source commit · as of · lens ·
      drawn by Farsight build · saved date); file name `farsight-<surface>-<source>[-<storyline|journey>]-sync<N>-<date>`.
      Client-side only, no dependency, no route. The Map export fits the band first and saves the whole band; the
      journey export switches to the Storyboard. Measured: the storyline board 3203×1657 in 0.24 s, the storyboard
      2880×3400 in 1.1 s. **Pinned link:** Share → *Copy pinned link* uses the existing `@sync:N` hash grammar plus
      `asof=<date>`; when the address pins a sync the server does not draw, a note beside the sync chip says *pinned to
      sync N · this server shows sync M* (the server cannot draw an older sync on demand; only `--as-of` at start).

## Release and CI — 2026-10-01

- **Releases are on demand.** `gh workflow run release.yml -f bump=patch|minor|major` (or the Actions tab; `-f dry_run=true`
  rehearses) runs the gates, bumps the root version, writes `CHANGELOG.md` and the release notes from conventional
  commits (`scripts/changelog.mjs`), commits `chore(release): vX.Y.Z` as `github-actions[bot]`, tags, packs, smoke-tests
  the tarball (`--version` must print the release commit; an ingest must succeed), pushes, and publishes a GitHub Release
  with `farsight-cli-X.Y.Z.tgz`. npm publish runs only when an `NPM_TOKEN` secret exists. → `docs/RELEASING.md`.
  **v0.1.1** is the first release (2026-10-01); a consumer install from the release URL into a clean prefix printed
  `farsight 0.1.1 · commit 00b18dd` and ingested the invoice-app example (87 nodes). (Until 2026-10-04 PRs were
  merged with merge commits so the changelog could walk every commit; since then PRs are squash-merged, below.)
- **Since 2026-10-03 a release is a release PR** (`main` is protected, no bypass): `release.yml` opens
  `chore(release): vX.Y.Z` from `release/vX.Y.Z` (version commit + `CHANGELOG.md` + `.github/release-notes/vX.Y.Z.md`,
  gates and smoke test already run); merging it runs `publish.yml`, which tags the release commit, packs, smoke-tests
  and creates the GitHub Release. A PR opened with `GITHUB_TOKEN` does not start CI — close/reopen it, or add a
  `RELEASE_TOKEN` PAT (`docs/RELEASING.md`). **Rehearsed for real with v0.2.0 (2026-10-04):** the workflow's gates and smoke test passed, PR #36 opened, its CI did
  not start (no `RELEASE_TOKEN`), a close/reopen started it, a merge commit merged it, publish.yml tagged `v0.2.0` and
  published the Release with `farsight-cli-0.2.0.tgz`. Add a `RELEASE_TOKEN` PAT to drop the close/reopen step.
- **Since 2026-10-04 PRs are squash-merged and the convention is enforced** (PR #38). `main` accepts only squash
  merges — GitHub settings: merge commits and rebase merges off, squash title = PR title, squash message = PR body,
  linear history required, branches deleted on merge — so one PR is one commit on `main` and one changelog line. The
  PR title must be a Conventional Commit and the body follows `.github/PULL_REQUEST_TEMPLATE.md` (*what changed · why ·
  how it was checked · left open*). CI's fourth job, **`commits`** (required), lints the PR title against the type and
  scope lists and every branch commit for shape (`scripts/lint-commits.mjs`, `pnpm lint:commits`); `pnpm install`
  installs the same lint as a `commit-msg` hook and sets `.gitmessage` as the commit template (`scripts/install-hooks.mjs`
  copies into `.git/hooks`; the LFS hooks stay). `changelog.mjs` turns a squash subject's ` (#N)` into a PR link;
  publish.yml finds the release commit as `chore(release): vX.Y.Z (#N)` and tags the squash commit. The lead merges with
  `gh pr merge <n> --squash`, keeping the title — the project skill `.claude/skills/git-pr-flow` carries the flow.
- **CI on every push and PR** (`ci.yml`): validate (install, build, typecheck, tests, string lint, ~1 min) and e2e
  (Playwright chromium, 109 specs, ~1.5 min) in parallel on Ubuntu; artifacts on failure; the live tracker tests skip
  there. First run on `main` green. → `docs/CI.md`. Watch: `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19.
- Small: `farsight work --help` from a non-git cwd prints the version banner and a *failed to run git* line instead of
  the work usage — the `--help` form of a subcommand should not touch git.

## Next work, ranked

**First (2026-10-06): the swarm's nine findings below are built (item 14) — the next things are the reference app's
rehydrated evidence (its own session installs the build, restarts its MCP, re-runs its unit and e2e suites with the
reporters stamped, re-syncs; the handoff prompt lives in the private folder), then the second swarm on one build and
one sync, asked also *what do you want next*, then the server-side query API round (`/graph` 411 MB at 245k nodes).**

**The 2026-10-05 swarm (eight personas, cold, on the reference app's own server at `4a44f4c`, judging only from
their own screenshots; reports outside the repo) — 8 × TRIAL, fit mean 6.4 (5.0–7.0): the storyline and the doors are
credited by every role (*the best "how our business runs in software" picture*; *beats grep for the call chase*), and
the same two things hold every score down. Ranked, convergent first (all nine worked in the swarm-fixes round, item
14; what each left open is listed under *The swarm-fixes round left open*):**

1. **One verdict per test cell** (6 roles) — *passed, by its own declaration · stale* beside *no test reaches this
   step*, *last run: skipped* and a tip saying *verdict unknown*; one file:line with two verdicts on two surfaces; the
   Tests matrix printing PASSED beside *skipped*. One evidence word computed once, printed the same everywhere.
2. **Stale, said once and only when true** (5) — all 18 journeys, every Portfolio row and all three test levels say
   *stale* / *no source digest* with no sentence saying against what; Settings *history 0 commits read* contradicts
   Changes *242 of 282 never ingested*.
3. **One word per position** (6) — *step* means the storyline position, the drawer's walk index (*STEP 232*), the
   drill's *stop*, the code register's *983 steps*; action counts disagree with the sheet's columns.
4. **A gate answers its click** (6) — today it turns amber or opens its service; the doors hide behind ▸; no gate →
   the call it guards → the tests that reach it; config checks listed as a contractor screen's gates.
5. **Chrome** (6–7) — Settings behind an unlabelled sun icon and absent from ⋯; a READ-ONLY session still offering
   *Sync*, *Save*, *Add source*; the Map legend opening over the board on every visit; the Sheet's *verified by* row
   overflowing; the Experiments row one word wide; the toolbar overflowing at 1440; `?` with four jobs; business
   opening on the Sheet.
6. **Storylines, second pass** — a branch kind for the correction journey (drawn as an ordinary step); an unknown
   `?storyline=` says so; ⌘K finds storylines; thumbnails on the cards; test evidence on the storyline board; the
   record's status lifecycle derived from the code. (The reference manifest's own step order — *Paid* before *Weekly
   consolidation* — was the lead's error and is fixed there.)
7. **Data holes the BA found** — the mark-paid and approval screens show *0 actions · 0 gates · calls: none indexed*
   while the street lists `POST …/mark-paid` under them; the e2e card badged VITEST over Playwright files and saying
   both *unknown* and *changed since the run*.
8. **Export** (3) — PNG/PDF of the storyline board, the storyboard and the Portfolio; a pinned, dated link.
9. **Business register, last ~30 words** — and ADR numbers kept as citation keys in every register.

**The swarm-fixes round left open (2026-10-06), by lane:**

- *Verdict:* a step no test reaches still prints *no test reaches this step* beside the action's own count (two
  scopes by design since 2026-09-25; four reviewers read it as a contradiction — a sentence that names both scopes is
  the fix); the Map property's per-case rows keep their own per-case labels; the scoped case list caps at 200 rows.
- *Freshness:* *stale* is repo-wide because the digest covers the whole source (per-journey needs the commit spine's
  touched files at fold time); the sentence names the two commits, not how many lie between; the AT RISK bar prints
  its shared sentence only when every stale journey compares with one code commit.
- *Words:* the front door's Designs/drift table and entry-point lists still print routes, design ids and file names
  in the business register (46 tokens); Portfolio descriptions keep `CON-01 to CON-08`; *the runtime container* and
  the API title are names the reference app wrote (rename or tag there); the `step=` URL parameter is a screen
  ordinal (renaming it touches many specs); `history.ts`'s *run `farsight ingest`* note still prints raw backticks on
  Changes; the business gate row has no tip with the team's original label.
- *Gate:* the drill lanes do not draw config checks; the card cannot say which test exercises the refusal path (no
  branch-level coverage); the card is not exportable and cannot seed Affected; a guard that reads its settings through
  a helper is not recognised as a config check.
- *Chrome:* a focused button that has a tip (`⋯ N`) opens it only on hover now (Enter presses the button); the work
  pane's write controls are not greyed on a read-only server (the server refuses them, the pane does not say so
  first); "nothing here" is still drawn three ways; the `mapLegendSeen` e2e fixture is dead; a reader who tabs directly
  onto a band header's count loses focus when a walk redraws it.
- *Storylines:* at board zoom the branch label can run past the band panel; the dashed return line is faint; the
  legend does not list *branch* / *back to*; cross-source storylines.
- *Data:* the approval (verified) state could say *its page makes N calls* instead of *calls: none*; handlers passed
  through render props or spreads, a `fetch` written inside the handed function, and member-call handlers
  (`mutation.mutate`) are not credited; lifecycles do not yet read Postgres `CREATE TYPE … AS ENUM`, Drizzle `pgEnum`
  or an INSERT's literal status; the prior status is blank when the writer compares two records; one lifecycle per
  record (the `status` column first); a property screen that reaches a record only through a repeated call shows no
  lifecycle.
- *Export:* the server cannot draw a pinned sync on demand (only `--as-of` at start); the Portfolio CSV is the cells'
  text, not typed `Counted` columns; cross-origin images (Figma URLs) stay empty in the picture; pictures past the
  canvas limits are scaled, not tiled; the Map export leaves the board fitted.
- *CI:* the e2e suite is timing-sensitive under load (four specs failed once each on a loaded machine and passed
  alone: `codemap-projects` where-is, `journey-ladder:60`, `map-journey-links:120`, `map-zoom` pinch); two races were
  fixed this round (#71, #67) — the pinch test's timing lives in `lib/map-canvas.js`.

**The 2026-10-05 round left open, first:** the `/graph` payload at scale (411 MB for 245k nodes) — a server-side query
API with the index semantics the viewer folds today is the next ceiling and a round of its own; the Map reads its
journeys one at a time (300 journeys > 30 s), `/api/tests` without `lean=1` is 243 MB, a code-map card click re-lays
out the whole map (~0.4 s), the first ⌘K keystroke within 0.5 s of boot waits for the index; the street's number chips
are not doors yet (a click opens the screen); a non-verb fetch helper that sets the method inside its own body is not
followed; cross-source storylines; a design row has no address of its own on the front door; the reviewer swarm on
this build (front door, Map with a storyline, the doors) is the next thing to run.

**The Map clarity pass left open (2026-10-04):** *at risk* shows on 18 of 21 cards on the dogfood graph (most
journeys there are stale — a second, quieter mark for *stale alone* may read better than one word for two facts);
with many more journeys on a small window the card text shrinks with the fit (nothing keeps it above 8 px); the layout
swap on a gesture is not animated (the neighbours snap); no e2e guard for the board-stop fix (the fixture shows no
risk headline); the Map's `h`/`l` keys walk model order, not persona-band order.

**The journey-organisation pass left open (2026-10-04), first because it is what the owner asked for:** declare
`personas` and `groups` in the reference app's own manifest (outside this repo) — today its three persona strings
are undeclared and every journey sits in *Other journeys*; the pass is only proven when *Access* leads each persona
there. Then, smaller: a nested config's `stores[]` catch-all still names every unnamed table in the source (declarations
are not scoped); a nested `storybook` without `configDir` is taken as `<dir>/.storybook`; the root file's own paths
are not checked for escapes; the Settings page has no *Config files* list (`/api/config` is ready); a flow placed in a
group that belongs to another persona drops to *Other journeys* with no note; two NX apps on the same route still
collide under route-only matching; the Map's `h`/`l` keys walk model order, not persona-band order; the echo card's
dashed border is faint at board zoom; a JSON schema for the config and the manifest (`schemas/`) would let editors
validate the many files this pass creates.


**Reported 2026-10-04 by the reference app's session, after 0.2.0 was installed there — a parser regression, first:**
a `fetch(url, helper(ctx, { method: 'POST', … }))` call, where the method literal sits in an object-literal argument of a
wrapper call rather than in fetch's own init, resolves to the **GET** route of the same path (the fallback is *no method
→ GET*; `apiInit(ctx, { method: 'GET' })` happens to be right). On the reference app design drift went 7 → 19: twelve
false *unreached POST / undeclared GET* pairs over five client functions (create submission, session from magic link,
ops invoice, two vendor-account creates). The 2026-10-01 build resolved these correctly on the same code, so it is a
regression of the data-stores pass (#15–#18). `packages/parsers/src/tsjs.ts`, the `fetch(` site: when the init argument
is a call expression, read a `method:` string literal from its object-literal arguments (spreads included), the way the
class-method path already does; a helper whose name is a verb (`post`, `put`, `patch`, `del`) is a fallback. A test with
that exact shape, then re-measure read-only on the reference app (drift back to 7, http edges to routes still 69).

**Left open by the code map performance pass (2026-10-04), small:** the app view narrows by the closure alone (a
kept project or tag filter no longer applies inside it — its chips are hidden there and would have emptied the tree
quietly); the toolbar gets crowded on a 1600 px window with tag chips on (they are cut off left of GROUP); a folded
file group's row in a box is taller than its card (gaps, no overlaps); a stale NX cache file is read as-is (its age is
not compared to the manifests); the viewer does not yet read `ProjectRow.closure` from `/api/projects` (it computes the
same tree from `meta.projects`, proven equal by test); `farsight deps list` does not print the NX-graph line (only MCP
`graph_overview` does). A broader thought the pass raised: `/graph` still ships the whole 48 MB graph to the browser and
every surface folds it client-side — the next ceiling is a server-side query API with the same index semantics.

**Left open by map pass 2 (2026-10-04), in order:**

1. PR #32 landed the round-2 blocker and its convergent findings (`_synthesis.md` in the private review folder has the
   ranked list); the lead re-checked the widest journey on 4477 by click, plumbing, link and `j` — all keep it. Still open:
   an export of the affected set for CI (a commit/PR seed with a deduplicated test list, `farsight-affected v1` once
   frozen), PNG/PDF of the board, screen tabs and *Where is it included* in the URL, a file:line on screen cards, the
   Tests page's *no source digest* warning on the cover, the word for `sql` stores in the business register; the
   three dependabot alerts were fixed on main in #30 but GitHub had not re-evaluated them at session end — dismiss
   as fixed if they are still open.
2. **Small things the lanes left:** the band label slips under the Affected bar on an already-framed street; the
   edge cue can overlap a card's evidence chip at ×0.52; the Code lens makes no visible change at journey zoom; the
   project and tag filters are not in the URL (group and view are); third-party packages in *App and its related* can
   land behind the inspector; imports from test and story files are not read; Java Maven/Gradle packages; X's
   project-dependency fold could read D's `imports` edges instead of re-scanning; `farsight-deps` is `v0`, not frozen.
3. **Journeys defects the comparison surfaced:** the rows / ladder switch is undiscoverable; a journey opens on the
   Sheet, where business readers give up; the *records* row per store once a journey touches two.

**Left open by the map-view and data-stores passes (2026-10-03), in order (still valid):**

1. **Run the pass swarm** on the dogfood server with the map on (one build, one sync): can a reader new to the
   reference app find a screen from the neighbourhood, say what it does and which stores it touches from the street,
   and act from the property?
2. **Image paste / upload** from the property placeholder, written into the source's design manifest (the bonus
   stream agreed on 2026-10-03).
3. **Map polish the real graph asked for:** route *leads to* curves between bands; raise the cover cap or base size
   past 30 journeys; per-screen work chips (one `/api/work/links?node=` per screen, cached); Impact in the explore
   card; the explore card for gates and tests; `⌘K` arriving on the map; export of the street as PNG.
4. **Data stores, next steps:** the journey band and ladder could split the *records* row per store once a journey
   touches two (today the row key stays `records` and only the map groups); `stitch.ts` cannot match a `? path` stub
   across sources (a call with no method on a shared path whose routes come from a spec in another source stays a
   stub); the three `unknown` stubs left on the reference app, and `/api/work/*` on Farsight itself, are routes the
   parser does not read as routes — a route-table reader for that shape.

**Left open by the work-items pass (2026-09-30), in order:**

1. **Run the work-items swarm** on the dogfood server against real tracker items: does a reader see
   what work changed what code, and can they act on a story from the pane? (Can share the build and sync with the
   map swarm above.)
2. **A real key in a real repo.** Put `KAN-…` keys in Farsight's own branch names and subjects from now on (the
   detector needs the project in a work source's scope), and give the reference app a `@work` / `screens.json work[]`
   declaration for one flow.
3. **Small gaps the lanes reported:** the `no-code` finding and links from tracker URLs in item bodies to pages/routes;
   the see-impact button seeds one touched part at a time because `/api/impact` takes one seed; ⌘K matches work nodes
   by key and title only; no create/label/link controls in the pane; the work e2e specs run on a stub, not the fixture
   provider; providers do not yet read `Session.schema` (ADO re-discovers every sync); `WorkCache` lacks
   `replaceLinks()`/`listPeople()` and a `dropped` intent state (drop and rebase record `failed`); the item answer's
   `user` is missing on the hybrid list card; source card titles print the provider twice; the Jira live test leaves
   `live-…` labels on KAN-3; a 503 path test for the work routes.

**From before this pass** (the story swarm's list after the 2026-09-27 pass):

1. **Re-run the story swarm** against one build and one sync of the reference app to re-score *where to go next*
   (1.9) now that evidence agrees with itself and owners are declared.
2. **The application's own change story.** Changes still shows re-syncs, not the application's commits: surface the
   commit spine per flow. Syncs recorded before the per-source digest column read *re-indexed*; only new syncs can say
   *tree-changed*. The journey header still says *1 test named by a run* for a pass by declaration — it should use
   `observation.declared` wording.
3. **Business register, last mile.** The glossary lands on `Class.method`; the identifiers that still print raw (gate
   names, record rows, *other ways in* paths, Tests-page terms) need words — the rule stands: words a person wrote or
   `humanize()`, never the identifier.
4. **An e2e report without a source digest** reads *no source digest was recorded* on the e2e card; a consumer
   stamps its report with `farsight tests import … --stamp` right after its run (never an old run with today's
   digest — that would be false evidence).
5. **Export**: PNG/PDF of the Storyboard and the Portfolio table, a pinned link; the matrix CSV exists, the rest
   does not.
6. **Narrative vs code as a finding.** When a flow description and the code disagree, the tool should show the
   disagreement with both provenances (the first instance of the documentation-as-source direction below).
7. Small: `journey-ladder.pw.spec.ts` can read column widths before the ladder draws when run beside
   journey-numbers (needs a wait on `.jrn-laddercell[data-seg="1"]`); MCP still lacks attribution/history
   spine/`gate`; `farsight-impact-tests v1` reports `evidence_class: observed` for a declared e2e case that passed
   (enum unchanged, data changed — review if a consumer pinned the old data).

## Direction noted 2026-09-27 — documentation and pre-code steps as a second source of truth

A gap in the product is that the graph's only source of truth is the code. A flow also has a life *before* code —
requirements, designs, decisions, work items — and documentation *beside* code. Farsight should be able to take
source of truth from both: the code as today, and documentation that is either **Farsight-enabled** (annotations the
way `@business`/`@group`/`@covers` already are), written in **Farsight's own format** (the way `screens.json`
declares planned flows and `openapi.yaml` declares contracts), or pulled from **other data sinks — Azure DevOps,
Jira, databases, memory stores**. Principle 1 holds: a documentation or work-item adapter emits the same schema, and
every lens is a view over one graph. Principle 2 bends, not breaks: where a document and the code disagree, the tool
shows the disagreement as a finding with both provenances rather than letting either silently win. Existing seams to
build on: planned journeys (`via: 'planned'`, declared operations), the design manifest, the OpenAPI post-pass,
`@covers` claims, and the `journey.absent.notIndexed` word that names exactly what such an adapter would bring in.
The first adapter, work items (`docs/proposals/work-items-sync.md`, with two research appendices under
`docs/proposals/work-items-sync/`), shipped on 2026-09-30.

## Direction noted 2026-09-30 — live tracker connections are the check, and the credential names

The work-items adapter is validated against **live** trackers, not only the fixture provider; the fixture provider
stays for CI.

**Credential naming.** One macOS keychain *service*, `farsight`; the *account* is `<provider>-<instance>`, where
provider ∈ {`jira`, `ado`} and instance is the site or org slug. Settings reference them as
`keychain:farsight/<account>`; the secret is only the token or PAT, never the user — the Jira user email lives in
settings as `auth.user`. Linux `secret-tool` and Windows DPAPI use the same two strings.

| tracker | keychain account | setting | what the secret is |
|---|---|---|---|
| Jira, example.atlassian.net | `jira-example` | `keychain:farsight/jira-example` | an Atlassian API token (≤ 1 year) |
| Azure DevOps, dev.azure.com/example-org | `ado-example` | `keychain:farsight/ado-example` | a PAT scoped to work items read (write later) |

Written by the person, once: `security add-generic-password -U -s farsight -a jira-example -w '<token>'`.
Read by the adapter: `security find-generic-password -s farsight -a jira-example -w`, in its own process.
**The keychain is the only home for a secret** — no env vars, dotfiles, settings values, docs or transcripts,
because those are what AI sessions and other tooling read easily. The `env:` form of the setting exists for CI, not
for a developer machine. A session checks a live tracker by running the tool (or a probe script) that reads the
keychain in-process and prints only the outcome, never the value.

**Decisions taken on the proposal's §13:** writes are exercised on the Jira test site only — on the Azure DevOps org
only `validateOnly` dry runs, never a real write. Per-user credentials; agent writes attributed *via Farsight
(agent)*. ADO *Resolved* → `in-progress`, name kept; the category set stays four. ADF converter: paragraphs,
headings, lists, code, links, mentions, simple tables; media as references. Retention: keep everything. Keychain via
the `security` CLI in-process (`secret-tool` on Linux, DPAPI not built). Key shapes: Jira `[A-Z][A-Z0-9_]+-\d+` bare
/ `#KEY-1` / `[KEY-1]` / `KEY-1:` / any `…/browse/KEY-1` URL; ADO `AB#4711`, `#4711` only when an ADO source exists,
and `_workitems/edit/4711` URLs; the same shapes in branch names.

## Where the detail lives

| file | what is in it |
|---|---|
| `docs/COUNTS.md` | **the counts ledger** — every number the product prints, its function, unit, scope and siblings |
| `docs/MAP-PACKAGES.md` | what lives in which package, file by file |
| `docs/MAP-VIEWER.md` | the viewer's modules, the journey's four views, the band mechanics |
| `docs/proposals/` | how each design was argued before it was built |
| `docs/contracts/` | the frozen machine contracts (`farsight-diff v1`, `farsight-tests-matrix v1`, `farsight-impact-tests v1`, `farsight-work v1`) |

When you finish a pass, add its summary to *What shipped most recently*, keep this file short, and keep the dated
detail (measurements on a client app, review evidence, session handoffs) outside the repo. It is read in full at the
start of every session.
