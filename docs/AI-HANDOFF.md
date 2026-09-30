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

## Current state — 2026-09-30

`main` is green.

| | |
|---|---|
| build | `0.1.0 · d6dace1` (the work-items pass) |
| tests | **761** — core 265 · work 57 · parsers 124 · work-fixture 18 · work-azdo 36 · work-jira 39 · mcp 42 · server 129 · cli 51, 0 failed · **e2e 107/107** · live tracker tests opt-in with `FARSIGHT_LIVE=1` (see below) |
| string/symbol lint | **1505 entries · 32 sprite symbols · 24 modules**; the define test bans backticks, markdown, unfilled placeholders and catalog keys |
| servers | the dogfood server on **4478** (workspace CLI). Check `lsof` before restarting or measuring on any port. |
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

## Next work, ranked

**Left open by the work-items pass (2026-09-30), in order:**

1. **Run the pass swarm** on the dogfood server against real tracker items (one build, one sync): does a reader see
   what work changed what code, and can they act on a story from the pane?
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
