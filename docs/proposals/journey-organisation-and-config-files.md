# Journeys organised by persona and group, and many config files per source (proposal, 2026-10-04)

**Status:** agreed on 2026-10-04 with the owner (four decisions in §3); three lanes (§8).

## 1. The ask

Two things, in the owner's words. **Config files:** *"multiple configuration files in a workspace for configuring
journeys and other config — important for our NX monorepos and large workspaces; easy to discover."* **Journeys:**
*"organise the journeys — group ops vs contractor; at the top, how to log in / out and those flows, then creating
vendor accounts, then creating, managing and tracking invoices — so you can see the ways to access and then the
actions you can do; the same for ops; in whatever custom order we want. Update MCP to expose this and make it easy
to manage."*

## 2. What exists today (survey 2026-10-04)

- `farsight.config.json` is read **only at the source root**, by six readers that each call
  `loadConfig(join(repoRoot, 'farsight.config.json'))` (`parsers/src/index.ts:66`, `design/index.ts:133`,
  `openapi/index.ts:28`, `tests/index.ts:84`, `stories/index.ts:338`; `shared/nx-graph.ts` takes `projects.graphFile`).
  Every path in it is repo-relative. No merge, no multi-file logic.
- Design manifests are already discovered **anywhere** under a `docs/`, `design/` or `designs/` segment
  (`screens.json` · `design.json` · `designs.json` · `figma-index.json`, `design/index.ts:19,111`), so an NX app's
  `apps/x/docs/design/screens.json` is found today. A flow's id is repo-scoped (`${repo}::flow::${id}`; the first one
  wins); `requires` / `leadsTo` resolve within one manifest.
- `DesignFlow` carries a free-text `persona` and `owner`. The Journeys front door (`surfaces/journeys.js:204`) and the
  Portfolio (`portfolio.js:172`) group flows by persona (falling back to the shared screen-id prefix, labelled
  *derived*), sort them **by name** with one pinned *way in*, inside one card **per manifest**. The Map bands by source
  or by domain. Nothing orders personas; nothing groups below a persona; the manifest's own order is not used.
- MCP has no tool that lists journeys: `design_surface` lists flows per manifest (no persona, owner or phase);
  `graph_overview` prints twelve. `design_guide` documents the manifest without `persona`, `owner`, `work`, `surfaces`.
- The reference app (read-only on 4478) has 18 flows over three persona strings — *Contractor*, *Operations*, and
  *"Contractor and Operations"* for the shared ones — which is exactly the shape §4 has to carry: one journey under
  two personas, and an access group first under each.

## 3. Decisions (owner, 2026-10-04)

1. **Where the organisation is declared: manifest + config override.** The manifest declares `personas[]` and
   `groups[]` in order and each flow names its persona(s), group and order; a `farsight.config.json → journeys` block
   orders personas and groups across manifests and can override a flow's placement by id. A project without a docs
   folder declares its journeys through its own nested config's `design[]` (paths relative to that file, §5).
2. **Many config files: a nested file scopes its subtree.** Any `farsight.config.json` below the root applies only
   to nodes under its folder; its paths are relative to that folder; lists union; for a node under two files the
   nearer wins (glossary word, tag); conflicts are reported, never silent. `projects` and `tooling` are root-only.
3. **Hierarchy: persona → group → journeys**, two fixed levels. A journey naming several personas appears under
   each.
4. **MCP: read + guide.** New tools `journeys` and `config_files`; `design_guide` carries the schema. An agent edits
   the files with its own tools and calls `refresh_graph`. Farsight never writes into a code source.

## 4. The journey organisation

### 4.1 Manifest (`screens.json`), additive

```json
{
  "name": "Contractor portal — screens",
  "personas": [
    { "id": "contractor", "name": "Contractor", "description": "A vendor who submits and tracks invoices." },
    { "id": "ops", "name": "Operations", "description": "The team that verifies vendors and approves invoices." }
  ],
  "groups": [
    { "id": "access", "name": "Access", "description": "Ways in and out." },
    { "id": "vendor-accounts", "name": "Vendor accounts", "persona": "contractor" },
    { "id": "invoices", "name": "Invoices" },
    { "id": "vendors", "name": "Manage vendors", "persona": "ops" }
  ],
  "screens": [ … ],
  "flows": [
    { "id": "contractor-sign-in", "name": "Sign in with email", "persona": "contractor", "group": "access", "order": 1, "screens": ["CON-01"] },
    { "id": "contractor-sign-out", "name": "Sign out", "persona": "contractor", "group": "access", "order": 2, "screens": ["CON-02"] },
    { "id": "vendor-account-creation", "name": "Create a vendor account", "persona": ["contractor", "ops"], "group": "vendor-accounts", "screens": ["CON-03", "OPS-04"] },
    { "id": "ops-sign-in", "name": "Sign in with the directory", "persona": "ops", "group": "access", "screens": ["OPS-01"] }
  ]
}
```

- `personas[]` — `{ id, name, description? }`, **in the order they are shown**.
- `groups[]` — `{ id, name, description?, persona? }`, in the order they are shown inside a persona. A group with
  `persona` exists under that persona only; one without exists under every persona that has a journey in it. The same
  group id under two personas is two sections with one word (*Access* under Contractor, *Access* under Operations).
- `flows[].persona` — a string **or an array**; each value matches a declared persona by `id`, else by `name`
  (case-insensitive, trimmed). A value no `personas[]` entry declares becomes a persona of its own (`declared:
  false`), placed after the declared ones, alphabetically — so a manifest written before this pass reads exactly as
  it does today. A flow with no persona falls under the trailing *No persona* persona (the existing word
  `portfolio.noPersona`); the screen-id-prefix derivation stays as the fallback and keeps its *derived* note.
- `flows[].group` — a string; matches a declared group by `id`, else by `name`; undeclared → a group of its own
  (`declared: false`) after the declared ones, alphabetically; none → the persona's trailing *Other journeys* group
  (new word `journeys.noGroup`, both registers).
- `flows[].order` — a number; ascending within the group; ties and absences in **manifest order** (the order the
  author wrote the flows), never alphabetical. This changes today's sort on purpose: the manifest's order is the
  author's intent. The pinned *way in* (the first unrequired flow with something built) is still computed and still
  shown, but it no longer jumps to the top.
- `DesignFlow`, `DesignRef` and `FlowRow` gain `persona: string | string[]`, `group?: string`, `order?: number`
  (FlowRow also `requires`, `leadsTo`, `repo` — the front door needs them). Existing fields and ids are unchanged; the
  fixture graph differs only where the example manifests change.

### 4.2 Config (`farsight.config.json → journeys`), any file

```json
{
  "journeys": {
    "personas": [ { "id": "contractor", "name": "Contractor" }, { "id": "ops", "name": "Operations" } ],
    "groups": [ { "id": "access", "name": "Access" }, { "id": "vendor-accounts", "name": "Vendor accounts", "persona": "contractor" } ],
    "flows": [ { "id": "contractor-sign-in", "persona": "contractor", "group": "access", "order": 1 } ]
  }
}
```

Same shapes. The config's arrays are the order; an entry overrides the manifest entry with the same id (name,
description, persona, group, order — field by field, only the fields it gives); ids the config does not name follow
in manifest order. `flows[]` here only **organises** flows a manifest declared — an id no manifest in scope declares
is a note (`journeys.notes`: *flow "x" is named by farsight.config.json but no manifest declares it*), never a
journey. The root file's block applies to every manifest of the source; a nested file's block applies to the
manifests under its folder (§5).

### 4.3 In the graph

- The organisation is **data on the graph**, not a disk read at request time: ingest folds every manifest's
  `personas` / `groups` and every config's `journeys` block into `fragment.meta.journeys: JourneysMeta` per source,
  and `GraphStore` keeps it as `meta.journeys[repo]` the way `meta.projects[repo]` is kept.

```ts
export interface JourneysMeta {
  personas: { id: string; name: string; description?: string; declared: boolean; from: string }[]; // from = manifest path or config path
  groups:   { id: string; name: string; description?: string; persona?: string; declared: boolean; from: string }[];
  flows:    Record<string, { persona?: string | string[]; group?: string; order?: number; from: string }>; // config overrides by flow id
  notes:    string[];
}
```

- Core `journeyTree(index, metas, scope?) → JourneyTree` is pure and unit-tested; `/api/journeys`, the MCP
  `journeys` tool and `farsight journeys` all call it, so the three cannot disagree.

```ts
export interface JourneyTree {
  personas: {
    id: string; name: string; description?: string; declared: boolean;
    groups: {
      id: string; name: string; description?: string; declared: boolean;
      journeys: JourneyRow[];                   // FlowRow + repo + requires + leadsTo + order, in the order §4.1 gives
      counts: { journeys: Counted; built: Counted };
    }[];
    counts: { journeys: Counted; built: Counted };
  }[];
  counts: { journeys: Counted; personas: Counted; groups: Counted };  // journeys counts each flow ONCE, however many personas show it
  derived: boolean;                             // some persona came from a screen-id prefix
  notes: string[];
}
```

Scope words: `count.scope.workspace` for the whole tree, a new `count.scope.persona` / `count.scope.group` for the
inner counts (`docs/COUNTS.md` § Journeys gets the rows). A flow shown under two personas is counted in each persona's
`journeys` and once in the tree's.

### 4.4 Surfaces

- **`GET /api/journeys?scope=`** → `{ generatedAt, scope, tree: JourneyTree }`.
- **Journeys front door** (`surfaces/journeys.js`): one organised section across the manifests in scope — persona
  heading, then its groups in order (collapsible; a persona with one group shows no group heading), then the journey
  cards as today (status chip, phase, screens, docs, *open journey*). The per-manifest design cards keep their counts
  and screen lists but drop the flow groups, which moved up. The persona/group of the open journey rides in the
  header line. `?persona=` and `?group=` filters in the hash, the way `?project=` does on the code map.
- **Portfolio** (`portfolio.js`): one table per persona → group in the same order, the same pin.
- **Map** (`map.js`, `lib/map-model.js`): *Band by: source · domain · persona*; inside a persona band the districts
  are in group then journey order. `MAP.band` gains `'persona'`.
- **MCP `journeys`** `{ repo?, persona?, group?, json? }`: the tree as text — persona heading, group heading, one line
  per journey `name — status word · built n of m · \`nodeId\` (open with journey)`; `json: true` returns the
  `JourneyTree`. **`graph_overview`** gains a *journeys* line: `18 journeys · 2 personas · 6 groups` and the first
  group of each persona.
- **CLI `farsight journeys [--repo r] [--persona p] [--json]`**: the same tree.
- **`design_guide`** documents `personas[]`, `groups[]`, `persona | persona[]`, `group`, `order`, the config `journeys`
  block, `owner`, `work`, `surfaces`, and §5's nested config files with their path rule. `docs/GETTING-STARTED.md` §4
  and §6 and `docs/proposals/design-source.md` §1 say the same.

## 5. Many `farsight.config.json` files per source

### 5.1 Discovery

Every `farsight.config.json` in the source — `collectFiles(repoRoot, ['.json'], options, base => base !==
'farsight.config.json')`, so the workspace's `exclude` globs apply and `node_modules`, `dist`, `.git` are skipped as
everywhere. The root file is the **root config**; each other is a **scoped config** with `dir` = its folder
(repo-relative, posix). Discovery and loading live in one place, `parsers/src/shared/config-files.ts`:

```ts
export interface ConfigFile { path: string; dir: string; config: FarsightConfig; root: boolean }
export interface WorkspaceConfig {
  root: FarsightConfig | null;
  files: ConfigFile[];                 // root first, then by dir depth then path
  /** the root config with every scoped file's LIST fields unioned and REBASED (paths prefixed with dir) — what the readers of design/openapi/tests/storybook consume */
  merged: FarsightConfig;
  meta: ConfigMeta;
}
export function loadWorkspaceConfig(repoRoot: string, options: IngestOptions): WorkspaceConfig
```

All six readers take the `WorkspaceConfig` (loaded once in `ingestRepo()` and passed down; `applyDesigns`,
`applySpecs`, `applyTests` and `applyStories` stop re-reading the file themselves and honour `options.config ===
false` uniformly).

### 5.2 Semantics, field by field

| field | kind | nested file |
|---|---|---|
| `tags`, `glossary`, `guards`, `entrypoints`, `setup` | node matchers | applied **only to nodes under `dir/`** (`loc.path` starts with `dir/`), after the root — so for a node under both the nearer file's glossary word wins and its tags add; a function the root already turned into a guard is **not** renamed again by a nested guard rule — that is a conflict (§5.3) |
| `plumbing` | path globs | rebased: `src/plumbing/**` in `apps/a/` → `apps/a/src/plumbing/**`; unioned |
| `design[]`, `openapi[]` | paths / URLs | rebased (`manifest`, `path`); URLs as they are; unioned; `name` kept |
| `tests.unit|integration|e2e.{results,coverage,report}`, `tests.include|exclude` | globs | rebased and unioned — `TestReportConfig.results|coverage|report` become `string \| string[]`; every report is read and its cases attributed by file path as today; `runner` per block |
| `storybook` | object or array | rebased (`configDir`, `root`); unioned into the array form |
| `externals[]`, `stores[]` | declarations | unioned; a second declaration of the same `import` / store `name` is a conflict (root kept) |
| `journeys` | organisation (§4.2) | the root's block applies to all manifests; a nested block to the manifests under `dir/` — same override rule |
| `projects`, `tooling` | workspace-wide | **root only**; a nested file's value is ignored with a note (`projects is root-only; apps/a/farsight.config.json's was ignored`) |

### 5.3 What is recorded

```ts
export interface ConfigMeta {
  files: { path: string; dir: string; root: boolean; fields: string[]; ignored: string[] }[];   // fields = the keys the file gave
  conflicts: { kind: 'glossary' | 'guard' | 'external' | 'store' | 'tag'; key: string; files: string[]; kept: string }[];
  notes: string[];                                                                               // unreadable files, ignored root-only fields
}
```

`fragment.meta.config`, kept by `GraphStore` as `meta.config[repo]`. A `farsight.config.json` that is not valid JSON
is a note with the path (today `loadConfig` returns `null` silently — the root's note is new too), never a failed
ingest.

### 5.4 Surfaces

- **MCP `config_files`** `{ repo?, json? }`: one line per file — path, root/scoped, the fields it gives, what was
  ignored — then the conflicts and notes; `json` returns `ConfigMeta`. **`graph_overview`** prints `config: 3 files
  (1 root · 2 scoped) · 1 conflict` per source when there is more than the root file.
- **CLI `farsight config list [--repo r] [--json]`**: the same.
- **`/api/config`** `?repo=` → `{ generatedAt, config: Record<repo, ConfigMeta> }` for the viewer's Settings page
  (a *Config files* list with the conflicts, read-only — small, lane A if time allows, else listed as left open).
- **Example:** `examples/nx-workspace` gains `apps/billing-web/farsight.config.json` (a glossary word and a
  `plumbing` glob relative to the app) and `apps/ops-admin/farsight.config.json` (a `design` declaration pointing at
  `docs/design/screens.json` **inside the app** — lane B writes that manifest, lane A only declares it; discovery
  would also find it by name, which the test asserts does not double-count), plus one deliberate glossary conflict
  with the root so `config_files` has something to show.

## 6. Principles check

1. One graph, many lenses — the organisation is graph data (`meta.journeys`) folded by one pure function every
   surface calls; config discovery writes `meta.config`, read by MCP, CLI and the viewer alike.
2. Code is the source of truth — a config or manifest organises what the code and the manifests declare; a flow the
   config names and no manifest declares is a note, not a journey. Nested configs scope to their folder so a project's
   words cannot rename another project's code.
3. Two audiences — persona and group names are words a person wrote; every new string has both registers and a
   define; the business register prints no identifiers.
4. Usability — *the ways to access, then the actions you can do* is the first thing the front door shows.

## 7. Counts (docs/COUNTS.md § Journeys, new)

| number | function | unit | scope |
|---|---|---|---|
| journeys in the tree | `journeyTree` | `count.unit.journeys` | `count.scope.workspace` — each flow once |
| journeys under a persona / in a group | `journeyTree` | `count.unit.journeys` | `count.scope.persona` / `count.scope.group` |
| built journeys under a persona / in a group | `journeyTree` | `count.unit.journeysBuilt` | same |
| personas · groups | `journeyTree` | `count.unit.personas` · `count.unit.groups` | `count.scope.workspace` |
| config files per source | `loadWorkspaceConfig` | `count.unit.configFiles` | `count.scope.source` |

## 8. Lanes

- **A — `feat(parsers): many farsight.config.json files per source, each scoped to its folder`** — §5 whole:
  `shared/config-files.ts`, the six readers, `ConfigMeta` on `graph.ts` + `store.ts`, `config_files` MCP tool
  (its own file `packages/mcp/src/config-tools.ts`, one registration line in `run.ts`, one line in `graph_overview`),
  `farsight config list`, the nx example's nested configs, tests, `docs/GETTING-STARTED.md` §4, `docs/MAP-PACKAGES.md`.
- **B — `feat(core): journeys organised by persona and group in declared order, over MCP, the API and the CLI`** —
  §4.1–4.3, `/api/journeys`, the `journeys` MCP tool (`packages/mcp/src/journeys-tools.ts`, one line in `run.ts`, the
  `graph_overview` journeys line), `farsight journeys`, `design_guide` + GETTING-STARTED §6 + design-source §1, the
  example manifests (`examples/invoice-app/docs/design/screens.json` gains personas and groups; `examples/nx-workspace`
  gains `apps/billing-web/docs/design/screens.json` and `apps/ops-admin/docs/design/screens.json`, one persona each,
  and the root one keeps its two flows), the config `journeys` block (parsed in core `config.ts`, folded into
  `meta.journeys` in `applyDesigns`), COUNTS.md § Journeys, tests.
- **C — `feat(viewer): the Journeys front door, Portfolio and Map organised by persona and group`** — §4.4's viewer
  half against the `/api/journeys` contract above (a stub until B lands, then `git merge main`), strings in both
  registers with defines, tips on every count, e2e specs on the fixture (the invoice-app example as B leaves it),
  `docs/MAP-VIEWER.md`.

A touches `parsers/src/design/index.ts` (the loader call) and B touches it too (folding `meta.journeys`): A owns
`applyDesigns`' signature and the config read, B owns the new fold function it calls — one adjacent hunk. Both add a
key to `GraphFragment.meta` and a block to `GraphStore.add`: adjacent hunks, merged by the lead.

## 9. Left open on purpose

Arbitrary nesting of groups; MCP tools that write into a manifest or config; a per-persona *way in* beyond the
computed pin; scoping a nested config's `journeys` block by project name rather than by folder; a JSON schema for
the manifest and the config (worth a follow-up: `schemas/farsight-config.schema.json` would let editors validate the
many files this pass creates).
