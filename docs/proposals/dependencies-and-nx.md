# Dependencies and NX — packages as nodes, projects and tags as facets, the code map grouped by them (proposal, 2026-10-03)

**Status:** agreed 2026-10-03; lanes D and X (wave 1, parsers + core), lane C (wave 2, the code map).

## 1. The ask

- **Dependency tracking, third-party and internal.** Which packages does the code depend on, where exactly is each one
  imported from, and which journeys does a change to a package reach? Today the graph records only the configured
  SDK externals; `import x from 'lodash'` is invisible, and a workspace library imported through a path alias is just
  another file.
- **NX awareness.** When a workspace uses NX, read its projects and their **tags** (`project.json`, or the `nx` key in a
  `package.json`), with the common dimensions (`scope:` → domain, `type:` → feature · ui · util · data-access …),
  configurable per workspace; group and filter the code map by project and by tag dimension; view *an app and its
  related projects*, and *every place a dependency is included from*.

## 2. Model (additive; principle 1: one schema, every lens reads it)

### 2.1 Packages

```ts
// graph.ts — a new NodeKind member (additive under the diff contract's growth rule; the enum in
// schemas/farsight-diff-v1.schema.json gains it, the contract doc records the addition)
| 'package'   // a dependency: a third-party package or a workspace library, id `${repo}::package::${name}`
// GraphNode for kind 'package':
package?: {
  scope: 'third-party' | 'workspace';     // workspace = resolved to a project/dir inside the indexed sources
  version?: string;                        // declared range from the nearest package.json (dependencies/devDependencies/peer)
  declaredIn?: string[];                   // package.json paths that declare it
  dev?: boolean;                           // only in devDependencies
  project?: string;                        // workspace: the NX project (or package name) it resolves to
}
// EdgeKind: 'imports' already exists; a module/function/component → package edge uses it with meta { specifier, line, names? }
```

Rules: every import whose specifier is bare (`lodash`, `@scope/pkg`, `node:fs`) resolves to a `package` node; `node:*`
and the runtime's built-ins are skipped (listed in meta as `builtins`); a specifier that maps through
`tsconfig.paths` / NX project aliases / workspace protocol to a directory inside an indexed source becomes
`scope: 'workspace'` and ALSO keeps the resolved file edge the adapter already makes. Version and declaredIn come
from the nearest `package.json` walking up from the importing file, then the workspace root. Java: Maven/Gradle
coordinates from `pom.xml` / `build.gradle` imports → `package` nodes by group:artifact (if cheap; else recorded as
next work). The configured `externals` keep their `external` nodes; a package that is also an SDK external links to
it (`meta.externalId`).

### 2.2 Projects and tags

```ts
// GraphNode (every node under a project root):
project?: { name: string; root: string; type?: 'application' | 'library' | 'e2e'; tags?: string[] };
// GraphFragment.meta.projects?: { tool: 'nx' | 'workspaces' | 'none'; projects: { name; root; type?; tags: string[]; implicitDependencies?: string[] }[];
//                                 tagDimensions: { key: string; prefix: string; label: string }[] }
```

Discovery: `nx.json` at a source root → NX; projects from every `project.json` and every `package.json` with an `nx`
key or matching the root `workspaces` globs (NX's inference rules, the subset we can read without running NX); `tags`
as written. Tag dimensions default to `scope:` → *domain*, `type:` → *type*, `platform:` → *platform*; a workspace adds
or renames them in `farsight.config.json`:

```json
"projects": { "tagDimensions": [ { "key": "domain", "prefix": "scope:", "label": "Domain" }, { "key": "type", "prefix": "type:", "label": "Type" } ],
              "tagValues": { "type": { "feature": "Feature", "ui": "UI", "util": "Utility", "data-access": "Data access" } } }
```

Without NX, `workspaces` globs give projects without tags; without those, one project per source. Project → project
dependencies are derived from the `imports` edges between their files (plus NX `implicitDependencies`), so the
project graph is a fold over the one graph, never a second store.

### 2.3 What the lenses read

- **Code map (lane C):** group by *project* and by any *tag dimension* (a group box per domain, per type …); filters:
  project, domain, type, *depends on <package>*; views: **App and its related** (an application project plus the
  closure of its project dependencies, everything else hidden) and **Where is <package> included** (every module with
  an `imports` edge to the package, grouped by project, with the version each project declares); the inspector for a
  package node: versions by project, importers, the journeys it reaches (via impact).
- **Map:** districts may band by *domain* instead of source when a workspace has tag dimensions (a toolbar choice);
  a package is a seed for the Affected mode (`map-pass-2026-10-03.md` §4).
- **MCP / CLI:** `describe_node` prints `project` and `package`; `search_graph` matches package names; `farsight deps
  list [--repo] [--project] [--third-party|--workspace]` and `farsight deps where <package>` print the same folds.
- **Counts:** `packages` (third-party · workspace), `projects`, `importers of <package>` as `Counted`s in `docs/COUNTS.md`.

## 3. Lanes

| lane | branch | owns | done when |
|---|---|---|---|
| **D — dependencies** | `feat/dependencies` | `core/graph.ts` (`package` kind, `GraphNode.package`), the diff schema enum + contract note, `parsers/src/tsjs.ts` import resolution → package nodes, `parsers/src/shared/packages.ts` (package.json walk, alias/path resolution shared with lane X), Java if cheap, `core/query.ts` folds (`packagesOf(repo)`, `importersOf(pkg)`), server `GET /api/deps` (list, where), MCP + CLI one-liners, tests, a fixture under `examples/` or the invoice-app gaining two third-party imports and one aliased internal import | the fixture graph shows `package` nodes with versions and `imports` edges; the golden diff still passes (new kind, no changed ids); impact from a package reaches its journeys |
| **X — NX projects and tags** | `feat/nx-projects` | `core/graph.ts` (`GraphNode.project`, `meta.projects`), `core/config.ts` (`projects.tagDimensions/tagValues`, soft-validated), `parsers/src/shared/projects.ts` (nx.json / project.json / package.json-nx / workspaces discovery, tag dimensions), stamping in `ingestRepo`, `core/query.ts` project graph fold, server `GET /api/projects`, tests, **an NX example workspace** `examples/nx-workspace/` (two apps, five libs with `scope:`/`type:` tags, path aliases, a third-party import) added to the dogfood sources and the e2e fixture set if the suite can afford it | every node of the NX example carries its project and tags; the project graph lists projects, tags and project → project dependencies; the reference app (measured read-only by the lead) gets its apps and libs |
| **C — the code map, grouped and filtered** (wave 2) | `feat/codemap-projects` | `surfaces/codemap.js`, `lib/graph-render.js` grouping, the code map CSS and strings, `docs/MAP-VIEWER.md` | the group-by (project · domain · type · none) and the filters (project, tag, depends-on) work on the NX example and the dogfood graph; *App and its related* and *Where is <package> included* are two clicks from the map; the inspector shows project, tags, package versions; the Map's band-by-domain toggle |

Lanes D and X both touch `graph.ts`, `config.ts` and `parsers/src/index.ts`: D adds the kind and the package field,
X adds the project field and meta; each keeps to its own block and merges the other's branch before its PR.
