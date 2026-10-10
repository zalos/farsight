/**
 * The Semantic Graph — the single contract every language adapter emits into
 * and every GUI lens reads from. See docs/ARCHITECTURE.md.
 */

export type NodeKind =
  | 'repo'
  | 'module'
  | 'file'
  | 'class'
  | 'function'
  | 'component' // UI component (React etc.)
  | 'page' // application/UI route (React Router, Angular routes…)
  | 'route' // HTTP endpoint
  | 'table' // database table / model
  | 'queue' // message topic / queue
  | 'rule' // validation rule / schema
  | 'guard' // auth / permission check
  | 'flag' // feature flag
  | 'external' // third-party service (an HTTP call to another host)
  | 'api' // an API surface: one OpenAPI/Swagger document (contains its route nodes)
  | 'design' // a design source: one screens manifest / Figma file (contains its screen nodes)
  | 'flow' // a named user flow from a design manifest: an ordered set of screens — a feature, and a journey entry
  | 'test' // one test case (it/test), or a synthetic run-level node for a report with no per-test attribution
  | 'work' // a work item from a tracker (Jira issue, Azure DevOps work item) — id work::<sourceId>::<key>, no loc
  | 'package' // a dependency: a third-party package or a workspace library — id `${repo}::package::${name}`, no loc (see PackageRef)
  | 'unknown'; // the "?" stub: a call the graph could not resolve to any indexed source

export type EdgeKind =
  | 'contains'
  | 'imports'
  | 'calls'
  | 'renders'
  | 'http' // client call site -> route (possibly cross-repo)
  | 'publishes'
  | 'consumes'
  | 'reads'
  | 'writes'
  | 'validates'
  | 'guards'
  | 'covers' // a test -> what it verifies; meta.evidence says declared | static | observed
  | 'tracks'; // a work item -> what it is about; meta.via says declared | commit | branch | url

/** Source location — powers IDE deep links (vscode://file/...). */
export interface Loc {
  repo: string;
  path: string;
  line: number;
  col?: number;
  /** Last line of the declaration's span (`line(node.end)`) — lets consumers slice whole bodies, not snippets. */
  endLine?: number;
}

/** One selectable arm of a branch point. */
export interface BranchArm {
  /** 'then' | 'else' | "case 'x'" | 'default' | 'try' | 'catch' | 'taken' */
  label: string;
  /** Condition that selects this arm: "speed >= 98", "!(speed >= 98)", "no exception thrown". */
  requires: string;
  /** First line of the arm's span (1-based, inclusive). */
  line: number;
  /** Last line of the arm's span. */
  endLine: number;
  /** Plain-language label for this arm, from a `// @business …` comment directive. */
  business?: string;
}

/** A decision point inside a function/component/route body. Static conditions only — what must hold, not what happened. */
export interface BranchPoint {
  kind: 'if' | 'switch' | 'ternary' | 'logical' | 'catch';
  /** Line of the test / discriminant / `try`. */
  line: number;
  /** Source text of the test, whitespace-collapsed, ≤120 chars. */
  condition: string;
  /** Some arm ends in return/throw — guard-clause shape. */
  exits?: true;
  /** Plain-language label for this fork, from a `// @business …` comment directive. */
  business?: string;
  arms: BranchArm[];
}

// ── API contracts: what a spec (OpenAPI/Swagger) declares about a route ──
// A spec is documentation about HTTP endpoints, so it augments the same
// `route` node ids the code adapters emit (docs augment, never replace).
// `status` says which evidence exists; `drift` is computed once by
// core/openapi.ts reconcile() and stored so every consumer shows one truth.

export type DriftKind =
  | 'spec-only' //                declared in the spec, no implementation found
  | 'code-only' //                implemented, missing from the spec (only stamped when the repo has a spec)
  | 'security-missing-in-code' // spec requires security; no guard on the route
  | 'security-missing-in-spec' // route is guarded; spec declares no security (only when the spec uses security at all)
  | 'security-mismatch' //        both sides gate it, but the scopes the spec names are not the ones the code enforces
  | 'deprecated-in-spec-only' //  spec marks it deprecated; code carries no deprecated tag
  | 'body-undeclared' //          code validates a request body the spec does not describe
  | 'body-unvalidated' //         spec requires a body; no validation rule is attached to the route
  | 'security-declared-only'; //  farsight.config.json declares a gate on the route; the code enforces none the parser can see

export interface ContractParam {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  type?: string;
  description?: string;
}

export interface OperationContract {
  /** both = declared + implemented · spec-only = declared, no implementation in a repo that has code · code-only = implemented, missing from the repo's spec · declared = from a spec-only source (no code to compare — not a gap) */
  status: 'both' | 'spec-only' | 'code-only' | 'declared';
  /** owning `api` node id (or the implied surface id `<repo>::api::implemented`) */
  apiId: string;
  /** where the operation sits in the spec file — powers the ⧉ deep link into the spec */
  spec?: { path: string; line?: number; operationId?: string };
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  params?: ContractParam[];
  requestBody?: { contentType?: string; schema?: string; required?: boolean; fields?: string[] };
  responses?: { status: string; description?: string; schema?: string }[];
  /** flattened security requirements: "bearer", "oauth2: billing:write" */
  security?: string[];
  /** server base paths the spec prefixes (`/v1`) — lets consumers match `fetch('/v1/x')` to `/x` */
  servers?: string[];
  /** operation-level `x-*` extensions, verbatim (`x-phase: 2`, `x-internal: true`) — scalars are mirrored as tags (`phase:2`, `internal`) */
  extensions?: Record<string, unknown>;
  drift?: { kind: DriftKind; message: string }[];
}

/** A harvested reference that is a link, not prose: `@see <url>`, `@design <url|id>`. Prose stays in `docs`. */
export interface NodeLink {
  /** doc = a repo-relative document (`ref`), opened with the ⧉ editor link like a source line */
  kind: 'see' | 'design' | 'doc';
  url?: string;
  /** a non-URL target: a symbol, a design id ("SCR-07"), a repo-relative doc path */
  ref?: string;
  /** the H1 of a repo-relative doc, read at ingest — the anchor's human title */
  title?: string;
}

/**
 * page/component nodes: where this screen was designed and how the design and
 * the code relate. From a `@design` annotation or a design manifest source.
 * Never carries image bytes — an `image` is a reference the server resolves.
 */
export interface DesignRef {
  /** both = designed + built · design-only = designed, not built · code-only = built, no design row (only when a manifest exists) */
  status: 'both' | 'design-only' | 'code-only';
  origin: 'annotation' | 'manifest';
  /** owning `design` node id (the manifest / Figma file) — absent for a bare @design annotation */
  designId?: string;
  /** stable id the docs use ("SCR-07") */
  id?: string;
  name?: string;
  /** Figma node id ("26-9") */
  nodeId?: string;
  url?: string;
  /** a repo-relative image, or a Figma render the server caches — resolved by /api/design/image, never inlined */
  image?: { kind: 'file' | 'figma'; path?: string };
  /** design-side last-modified; `freshness` says where it came from */
  lastModified?: string;
  freshness?: 'figma' | 'manifest';
  /** operationIds the design says this screen uses */
  operations?: string[];
  phase?: string;
  /** flow nodes only: the flows this one requires first / leads to next (manifest flow ids) — linked journeys */
  requires?: string[];
  leadsTo?: string[];
  /** flow nodes only: who the flow is for (one persona or several), and who answers for it (absent prints as an absence word) */
  persona?: string | string[];
  owner?: string;
  /** flow nodes only: the group the manifest puts it in under its persona(s), and its order there (journey-organisation-and-config-files.md §4.1) */
  group?: string;
  order?: number;
  /** flow nodes only: where the flow sits in its manifest's `flows[]` (0-based) — the author's order, which ties and absent `order`s fall back to */
  position?: number;
  /** screen nodes only: the numbered steps its spec and tests name (`SCR-07.2`) */
  steps?: { id: string; name: string; operation?: string }[];
  /** design nodes only: the product surfaces the manifest scopes, drawn or not */
  surfaces?: { id: string; name: string; status?: 'built' | 'partly built' | 'not started'; description?: string }[];
  drift?: { kind: DesignDriftKind; message: string }[];
}

export type DesignDriftKind =
  | 'design-only' //            designed, no page/component at that route
  | 'code-only' //              page exists, no design row (manifest present)
  | 'operation-not-in-spec' //  manifest names an operationId no contract declares
  | 'operation-unreached' //    built page never reaches an operation the design says it uses
  | 'operation-undeclared' //   built page calls an operation the design does not list
  | 'screen-unknown' //         a flow names a screen id the manifest does not define
  | 'flow-unknown'; //          a flow's requires/leadsTo names a flow id the manifest does not define

// ── tests: what verifies this, and how do we know ──────────────────────────
// docs/proposals/tests-surface.md §3.1. A `test` node is one test case; a
// `covers` edge says what it verifies and carries its evidence class. Claims
// (@covers) are never rendered as observations (a coverage report).
//
// Documented `meta` keys on a `covers` edge (GraphEdge.meta, untyped by design):
//   evidence : 'declared' | 'static' | 'observed'  — frozen; the printed word for `static` is *reached*
//   inactive : true                                — the case is .skip/.todo; the edge lifts no chip
//   match    : 'name+line' | 'name' | 'line±1'     — observed edges: how the coverage hit met the node
//   signal · helper · line · hits                  — how a static/observed edge was found

/** What one test run said about one test — joined to the graph by node id + a source digest. */
export interface TestRun {
  /** report file digest or the reporter's run id */
  id: string;
  /** ISO timestamp the report recorded */
  at: string;
  /** `flaky` = the reporter retried and the case ended green; it is not `passed` and never prints as one */
  status: 'passed' | 'failed' | 'skipped' | 'flaky' | 'unknown';
  durationMs?: number;
  /** retries the reporter recorded (Playwright: results.length - 1) */
  retries?: number;
  /** the Playwright / Nx project this run belongs to — one TestRun per project */
  project?: string;
  /** how the report row was joined to the node: an exact full name, or a `.each` template turned into a pattern */
  join?: 'exact' | 'each-template';
  /** `.each` only: how many expanded rows this template joined */
  rows?: number;
  /** the repo content digest (or legacy sourceHash) at run time, when the reporter recorded one */
  sourceDigest?: string;
  /**
   * unchanged = a recorded sourceDigest equals the fragment's · changed = it differs ·
   * unknown = no digest was recorded. A file mtime alone never proves freshness
   * (swarm review 2026-09-14 §3-C.1), so `unknown` is the honest default.
   */
  freshness: 'unchanged' | 'changed' | 'unknown';
  /** freshness === 'changed' — the source moved after the run. `unknown` is not stale and not fresh. */
  stale: boolean;
  /**
   * `changed` only: **what** moved. `commit` = the checkout is on a different
   * commit than the one the run saw · `working-tree` = the same commit, and the
   * files differ — the working tree differs from HEAD (uncommitted edits at the
   * run or now), which no commit list will show. Decided from the commit the
   * stamp recorded when it has one, otherwise from HEAD's commit time against the
   * run's time (a HEAD committed before the run was already checked out).
   * Absent when git could not be asked. The Tests and Changes surfaces say the
   * same thing from it (story swarm 2026-09-25: *the code changed after this
   * run* beside a Changes spine at one commit for 27 syncs).
   */
  changedBy?: 'commit' | 'working-tree';
  /** the commit the report's stamp recorded (`farsight.commit`), when it recorded one */
  commit?: string;
  /** repo-relative path to the html/json report for the ⧉ link */
  report?: string;
}

/** `test` nodes only: what kind of test this is and where it sits — like `contract` on a route. */
export interface TestRef {
  level: 'unit' | 'integration' | 'e2e';
  runner: 'vitest' | 'jest' | 'node:test' | 'playwright' | 'cypress' | 'junit' | 'other';
  /** describe path, outermost first */
  suite: string[];
  /** Playwright project / Nx project */
  project?: string;
  /** repo-relative spec path (loc.path is the same; kept for grouping) */
  file: string;
  /** raw @covers values as written, resolved or not */
  declares?: string[];
  /** @covers values nothing in the graph matched — drawn as orphans, never silently dropped */
  unresolved?: string[];
  /** true for the synthetic run-level node a report with no per-test attribution hangs off */
  runLevel?: boolean;
  /** last observed run, joined by test id */
  run?: TestRun;
  /** every run seen for this case, one per project; `run` stays and is the fold — older consumers keep working */
  runs?: TestRun[];
  /** .skip / .todo: the case exists, its static edges carry `meta.inactive` and lift no chip */
  inactive?: boolean;
  /** run-level nodes only: the repo-relative files the coverage report contains (hit or not) — the whole-scope exactness rule reads it */
  files?: string[];
}

/** What was read to produce the `covers` edges of a fragment — printed next to freshness. */
export interface TestsMeta {
  /** spec files claimed as tests */
  files: number;
  /** test cases extracted */
  cases: number;
  /** covers edges by evidence class */
  edges: { declared: number; static: number; observed: number };
  /** test cases a results report was joined to (status/duration on the node) */
  runs: number;
  /**
   * One entry per matched report file, plus (from the named-gaps pass) one per configured
   * glob that matched nothing. `glob`/`matched`/`reason` and the join counts are optional
   * because a graph written by an older build has neither.
   */
  reports: {
    kind: 'results' | 'coverage';
    runner: string;
    level: string;
    freshness: TestRun['freshness'];
    /** absent on a glob that matched no file */
    path?: string;
    /** the configured glob this entry came from */
    glob?: string;
    /** how many files that glob matched */
    matched?: number;
    /** why this entry reads the way it does */
    reason?: 'ok' | 'no-match' | 'unreadable' | 'empty' | 'no-digest' | 'digest-changed';
    /** `digest-changed` only: a new commit, or the same commit with a working tree that differs (`TestRun.changedBy`) */
    changedBy?: 'commit' | 'working-tree';
    /** the commit the report's stamp recorded (`farsight.commit`), when it recorded one — the run's side of the freshness sentence */
    commit?: string;
    mtime?: string;
    runId?: string;
    /** results reports: test cases this report was joined to */
    joined?: number;
    /** results reports: rows the report itself carried */
    rows?: number;
    /**
     * results reports: rows that reached no test node at all — the run saw a case
     * this graph does not index. `rows - joined` cannot answer it (one row may join
     * several nodes, and the rows of one `.each` template fold into a single run),
     * so the count is recorded on its own. Absent on a graph written before this.
     */
    unjoined?: number;
    /** coverage reports: observed covers edges this report produced */
    edges?: number;
    /** `.each` templates joined / left unjoined by this report */
    eachJoined?: number;
    eachUnjoined?: number;
  }[];
  /**
   * Structured, ordered and uncapped — every blind spot as data, so a consumer can
   * name the glob and the paths instead of re-parsing a sentence. Optional: an
   * older graph has only `blindSpots`.
   */
  gaps?: {
    kind: 'missing-artefact' | 'unreadable' | 'empty' | 'unresolved-claim' | 'unjoined-each' | 'no-digest' | 'digest-changed' | 'no-config';
    level?: string;
    reportKind?: 'results' | 'coverage';
    glob?: string;
    paths: string[];
    /** the sentence `blindSpots` carries for this gap */
    text: string;
  }[];
  /** one honest sentence per gap — "No unit coverage report found; declared and static evidence only" */
  blindSpots: string[];
  /** the content digest the fragment was ingested at — what a stamped report must equal */
  sourceDigest?: string;
  /**
   * HEAD when this read compared a stamped report with the code — the code's side of
   * every freshness sentence (core `freshness.ts`). Absent when no report recorded a
   * digest, or git could not be asked.
   */
  head?: { sha: string; at?: string };
}

/**
 * `external` nodes only: which third-party system this is and how we knew it.
 * Three sources, one node (the clarity-phase plan §1):
 * an SDK specifier the parser recognises, a non-literal `fetch` behind a constant
 * host, or a `farsight.config.json → externals` declaration.
 */
export type ExternalKind = 'erp' | 'ocr' | 'files' | 'email' | 'queue' | 'db' | 'http';

export interface ExternalRef {
  kind: ExternalKind;
  /** how this external was known: the SDK specifier, the host constant, or farsight.config.json */
  source: 'sdk' | 'host' | 'config';
  /** the client class the edges come through (BcClient · AzureDocumentIntelligenceProvider · AzureBlobFileStore) */
  via?: string;
  /** the package specifier (sdk) or the constant's name (host) */
  ref?: string;
  /**
   * this external is used as a data store — the app reads from it and writes to it, so a journey
   * draws it like a record. Default from the kind (`erp` · `db` · `files` are stores; `ocr` · `http`
   * are not; `email` · `queue` are messages), overridden by `farsight.config.json → externals[].store`.
   */
  store?: true;
}

/** The kinds of data store a record (or a store-like external) lives in. */
export type StoreKind = 'sql' | 'document' | 'files' | 'erp' | 'other';
/** A database engine, when the code or the config names one. */
export type StoreEngine = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'mongodb';
/**
 * How a store was known — code first, config last; the first rule that applies wins and nothing is guessed
 * (docs/proposals/data-stores.md §3.1):
 * - `factory`    — the table was declared with an engine-specific factory (`pgTable` · `mysqlTable` · `sqliteTable`)
 * - `sdk`        — exactly one SQL driver package is imported anywhere in the repo (`pg`, `mysql2`, …); two different
 *                  drivers name nothing
 * - `datasource` — a `schema.prisma` `datasource { provider = … }` block
 * - `jpa`        — Java: `spring.datasource.url` in `application.properties` / `.yml`, engine from the jdbc prefix
 * - `config`     — `farsight.config.json → stores[]` (tables the code left unnamed) or a store-like `externals[]` entry
 */
export type StoreVia = 'factory' | 'sdk' | 'datasource' | 'jpa' | 'config';

/** `table` nodes, and `external` nodes that are stores: which data store this lives in and how we know. */
export interface StoreRef {
  /** the store's name in words: 'Postgres', 'Business Central', 'Azure Blob Storage' — a product name or a config word */
  name: string;
  kind: StoreKind;
  engine?: StoreEngine;
  via: StoreVia;
  /** what the rule read: 'pgTable' · 'pg' · 'schema.prisma' · 'spring.datasource.url' · the config entry */
  ref?: string;
}

// ── stories: a component shown on its own (docs/ARCHITECTURE.md ADR 9) ─────
// A story file is code — `*.stories.*` in Component Story Format — so the
// stories pass reads it at ingest and puts each story on the component node it
// renders, whether or not any Storybook runs. A running Storybook is only the
// renderer: the server probes its `/index.json` and maps entries onto the same
// ids. Stories are an attribute of the component, not nodes of their own: a
// story has no behaviour a journey, an impact walk or a coverage denominator
// would read, and it is always about exactly one component.

/** One story (CSF named export) of a component. */
export interface StoryRef {
  /** the Storybook story id, computed the way Storybook computes it: sanitize(title) + '--' + sanitize(name from export) */
  id: string;
  /** the name a person reads: the story's `name:`, else the export name in start case ("As Link") */
  name: string;
  /** the story's `title:` (`Primitives/Button`), or the auto-title Storybook derives from the path */
  title?: string;
  /** 'meta' = written in the file's default export; 'auto' = derived from the path the way Storybook would */
  titleFrom?: 'meta' | 'auto';
  /** the CSF export name ("AsLink") */
  exportName: string;
  /** repo-relative story file */
  file: string;
  line: number;
  /** the JSDoc above the story export — what the author says this story shows */
  docs?: string;
  /** repo-relative config dir of the Storybook whose stories globs collect this file; absent when none does */
  storybook?: string;
}

/** One Storybook a repo carries: where its config lives, and where it runs when it runs. Farsight never starts it. */
export interface StorybookRef {
  /** repo-relative `.storybook` directory */
  configDir: string;
  /** repo-relative directory Storybook resolves `importPath`/`componentPath` against (default: the config dir's parent) */
  root: string;
  /** where it is served when it runs — absent when nothing said and nothing could be read */
  url?: string;
  /** config = farsight.config.json · script = a port read from project.json/package.json · default = Storybook's own default port */
  urlFrom?: 'config' | 'script' | 'default';
  /** the command that starts it, for the not-running sentence */
  command?: string;
  /** a display name */
  name?: string;
  /** config = declared in farsight.config.json · discovered = a `.storybook/main.*` found in the repo */
  source: 'config' | 'discovered';
  /** the `stories` globs its main file declares, relative to the config dir, as written */
  globs?: string[];
}

/** What the stories pass read, per repo — printed next to the stories themselves. */
export interface StoriesMeta {
  storybooks: StorybookRef[];
  /** story files read */
  files: number;
  /** stories put on a component node */
  stories: number;
  /** components that carry at least one story */
  components: number;
  /** story files whose stories reached no node — kept, never dropped, so a reader can fix the name */
  unresolved: { file: string; reason: 'no-component' | 'component-unresolved' | 'unparsed'; component?: string; stories: number }[];
}

/** What the store pass read, per repo (parsers/src/stores.ts) — the evidence behind each table's `store`, and what named nothing. */
export interface StoresMeta {
  /** SQL driver packages the code imports, with how many files import each — the `sdk` rule's evidence */
  drivers?: { spec: string; files: number }[];
  /** how many table nodes got a store from each rule */
  named?: Partial<Record<StoreVia, number>>;
  /** table nodes no rule named a store for */
  unnamed?: number;
  /** one sentence per rule that read something and named nothing on purpose (two drivers, an env() provider…) */
  notes?: string[];
}

// ── dependencies: packages as nodes (docs/proposals/dependencies-and-nx.md §2.1) ──
// A `package` node is one dependency of one source: a third-party package (`zod`, `@scope/pkg`)
// or a workspace library a path alias / workspace package name resolves to. The edges into it are
// `imports` edges: one from the importing file's `module` node (`${repo}::module::${path}`, the
// *where it is included* fact) and one from each function/component whose body uses an imported
// binding (the fact an impact walk needs to reach journeys).
//
// Documented `meta` keys on an `imports` edge into a package (GraphEdge.meta, untyped by design):
//   specifier : the text the code wrote (`lodash/fp`)        line : the import's line in the importer's file
//   subpath   : what follows the package name (`fp`)          names : the imported names, comma-joined
//   typeOnly  : `import type` — erased at build               form : 'import' | 'reexport' | 'require' | 'dynamic'
//   use       : true on a function → package edge (the line is then the first use in the body)

/** Where a dependency is declared: one `package.json` and the range it writes. */
export interface PackageDeclaration {
  /** repo-relative path of the package.json */
  path: string;
  /** the range as written (`^3.23.8`, `workspace:*`) */
  range: string;
  field: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
}

/** package nodes: which dependency this is and where it is declared. */
export interface PackageRef {
  /** workspace = resolved to a directory inside the indexed source (a path alias or a workspace package name) */
  scope: 'third-party' | 'workspace';
  /** the declared range — when every declaration agrees; else the one nearest the source root (`declarations` keeps all) */
  version?: string;
  /** the package.json paths that declare it, repo-relative, sorted */
  declaredIn?: string[];
  /** declared only in devDependencies */
  dev?: true;
  /** workspace: the project (or workspace package name) it resolves to */
  project?: string;
  /** workspace: the repo-relative directory it resolves to */
  root?: string;
  /** every declaration, so two package.json files that disagree both stay visible */
  declarations?: PackageDeclaration[];
  /** this package is also a configured SDK external: the `external` node it names (the external keeps its node) */
  externalId?: string;
  /** one sentence when something about it is missing: imported but declared in no package.json above the importer */
  note?: string;
}

/** Fragment meta: what the import pass read and set aside on purpose. */
export interface PackagesMeta {
  /** Node built-ins the code imports (`node:fs`, `path`), with how many files import each — never package nodes */
  builtins?: { spec: string; files: number }[];
  /** bare specifiers that matched a tsconfig path alias but resolved to no file — never guessed into a package */
  unresolvedAliases?: number;
  /** package nodes imported but declared in no package.json above any importer */
  undeclared?: number;
}

// ── projects: which workspace project a node belongs to (docs/proposals/dependencies-and-nx.md §2.2) ──
// Read once per source by parsers/src/shared/projects.ts: NX (`nx.json` + every `project.json` and every
// `package.json` with an `nx` key or inside the root `workspaces` globs), plain workspaces, or one project
// per source. Tags are kept as written; a tag *dimension* (`scope:` → domain) is how a lens groups them.
// The project graph is a fold over the one graph (core/projects.ts), never a second store.

/** What kind of project NX says this is; `e2e` is an application project whose name or tags say it tests another. */
export type ProjectType = 'application' | 'library' | 'e2e';

/** On every node whose file lies under a project root (the longest root wins). */
export interface ProjectRef {
  name: string;
  /** source-relative project root (`libs/billing/ui`; `.` for a whole source) */
  root: string;
  type?: ProjectType;
  /** the project's tags as written (`scope:billing`, `type:ui`) — absent when it has none */
  tags?: string[];
}

/** One project of a source, as discovery read it. */
export interface ProjectDecl {
  name: string;
  root: string;
  type?: ProjectType;
  tags: string[];
  /** NX `implicitDependencies` — project names, exclusions (`!x`) left out */
  implicitDependencies?: string[];
  /** NX `sourceRoot`, when written */
  sourceRoot?: string;
  /** where the project was read: a `project.json`, a `package.json` (an `nx` key or a workspaces glob), or the source itself */
  via: 'project.json' | 'package.json' | 'source';
}

/** A tag dimension: the tags starting with `prefix` give the node a value under `key` (`scope:billing` → domain billing). */
export interface TagDimension {
  key: string;
  prefix: string;
  label: string;
}

/** Imports from one project's files into another's, read at ingest from the import statements themselves. */
export interface ProjectImports {
  from: string;
  to: string;
  /** import statements in `from`'s files that resolve to a file of `to` */
  imports: number;
  /** files of `from` carrying at least one of them */
  files: number;
  /** the files with the most such imports, most first (at most five) */
  top: { path: string; imports: number }[];
}

/** What the projects pass read, per source — `GraphFragment.meta.projects`. */
export interface ProjectsMeta {
  tool: 'nx' | 'workspaces' | 'none';
  projects: ProjectDecl[];
  tagDimensions: TagDimension[];
  /** words for tag values per dimension key (`type` → `data-access` → *Data access*), from farsight.config.json */
  tagValues?: Record<string, Record<string, string>>;
  /** project → project imports between their files (the project graph adds `implicitDependencies` on top) */
  imports?: ProjectImports[];
  /** one sentence per thing read and set aside (a project.json that is not JSON, two projects with one name) */
  notes?: string[];
  /**
   * project → project dependencies NX's own project graph records, read from the file NX wrote
   * (`.nx/workspace-data/project-graph.json`, an older cache path, or `farsight.config.json →
   * projects.graphFile`) — never by running NX. Only names discovery found count; `npm:` targets are
   * the dependencies pass's. The imports read from the files stay the primary evidence; this augments.
   */
  dependencies?: NxProjectDependency[];
  /** the NX project-graph file that was read: its source-relative path, the projects and dependencies it named that counted */
  graphFile?: { path: string; projects: number; dependencies: number };
}

/** A persona a manifest or a config declares — `{ id, name, description? }`, in the order it is shown. */
export interface JourneyPersonaDecl { id: string; name: string; description?: string }
/** A group of journeys under a persona; with `persona` it exists under that persona only. */
export interface JourneyGroupDecl { id: string; name: string; description?: string; persona?: string }
/**
 * A storyline — a named chain of journeys across features and personas (round-2026-10-05 §2): the whole life of
 * one business thing, an invoice from upload to payment. `journeys` are flow ids of the same source, in order.
 */
export interface JourneyStorylineDecl {
  id: string; name: string; description?: string; journeys: (string | JourneyStorylineEntryDecl)[];
  /** the lanes the swimlane layout names or overrides (round 2026-10-10 §2) — derived lanes draw without them */
  lanes?: JourneyStorylineLaneDecl[];
  /** hand-offs the swimlane layout draws when the graph finds both ends (round 2026-10-10 §2) */
  handoffs?: JourneyStorylineHandoffDecl[];
}
/**
 * One lane of a storyline's swimlane layout, as a manifest or a config names it (round 2026-10-10 §2): a lane is a
 * persona's (`persona`, a declared persona id) or a store's (`store`, the name the code or the config gives it).
 * `name` replaces the lane's word, `surface` is a second line (where that person works). Lanes are derived from the
 * graph; an entry only names, orders or overrides one — an entry the graph cannot find is a note, never a lane.
 */
export interface JourneyStorylineLaneDecl { id: string; persona?: string; store?: string; surface?: string; name?: string }
/**
 * A hand-off the swimlane layout draws (round 2026-10-10 §2): `from` / `to` are a lane id or a screen of a journey of
 * the storyline written `<journey id>#<n>` (its n-th screen, 1-based). `moves` — the screen moves the record into
 * `status` in a store lane; `seen` — a screen in another lane reads the record in `status`. Drawn only when the graph
 * finds both ends; otherwise a note.
 */
export interface JourneyStorylineHandoffDecl { from: string; to: string; kind: 'moves' | 'seen'; status?: string; when?: string }
/**
 * One entry of a storyline's `journeys` list written as an object (swarm-fixes 2026-10-05 §6): `{ id }` alone is a
 * step like a bare id; with `branchOf` it is a **branch** — a journey that leaves the chain at that step only when
 * `when` holds (a correction, a rejection, a hold), and comes back at `rejoins` when it gives one. A branch is a fact
 * the design declares, never guessed from the code.
 */
export interface JourneyStorylineEntryDecl { id: string; branchOf?: string; when?: string; rejoins?: string }
/** A declared branch of a storyline, its ids resolved to flow ids the source declares. */
export interface JourneyStorylineBranch { id: string; branchOf: string; when: string; rejoins?: string }
/** A config entry that places a flow a manifest declared: only the fields it gives override the manifest's. */
export interface JourneyFlowPlacement { id: string; persona?: string | string[]; group?: string; order?: number }

/**
 * How one source's journeys are organised — `GraphFragment.meta.journeys`, folded at ingest from every
 * manifest's `personas[]` / `groups[]` and the config's `journeys` block (core design.ts `journeysMetaOf`).
 * The flows themselves stay on their `flow` nodes; this carries the declarations and the config's overrides.
 */
export interface JourneysMeta {
  /** declared personas in the order they are shown; `from` = the manifest or config path that declared it (the config when it named it) */
  personas: { id: string; name: string; description?: string; declared: boolean; from: string }[];
  groups: { id: string; name: string; description?: string; persona?: string; declared: boolean; from: string }[];
  /** the config's placements, by flow id — only flows a manifest declared */
  flows: Record<string, { persona?: string | string[]; group?: string; order?: number; from: string; index: number }>;
  /**
   * declared storylines in the order they are shown: each a chain of flow ids of this source, in order (only ids a
   * manifest declares — any other is a note); `from` = the manifest or config path that gave the words. Absent on a
   * graph ingested before storylines existed.
   */
  storylines?: {
    id: string; name: string; description?: string; journeys: string[];
    /** the branches it declares, in the order written: each leaves the chain at a step of `journeys` (absent: none) */
    branches?: JourneyStorylineBranch[];
    /** the lanes and hand-offs the swimlane layout names (absent: none — every lane is derived) */
    lanes?: JourneyStorylineLaneDecl[];
    handoffs?: JourneyStorylineHandoffDecl[];
    declared: true; from: string; notes?: string[];
  }[];
  /** one sentence per thing set aside (a config flow id no manifest declares) */
  notes: string[];
}

/** One dependency NX's project graph records (`static` an import NX read, `dynamic` a lazy `import()`, `implicit` declared). */
export interface NxProjectDependency {
  from: string;
  to: string;
  type: 'static' | 'dynamic' | 'implicit';
  via: 'nx-graph';
}

/**
 * A record's status lifecycle, read from the code (parsers/src/lifecycle.ts): the statuses one
 * field of the record may hold, in the order the code declares them, and each move between them
 * that a function performs. Never drawn by hand and never guessed: a status is listed only because
 * a declaration names it, a transition only with the function that writes it, and `from` only when
 * that function compares the field to exactly one prior status.
 */
export interface RecordLifecycle {
  /** the field the statuses live in, as the code spells it (`status`, `bc_sync_status`) */
  field: string;
  /** in declared order */
  statuses: string[];
  transitions: LifecycleTransition[];
  /** where the statuses are declared; the first is the declaration whose order `statuses` keeps */
  provenance: LifecycleSource[];
}
export interface LifecycleTransition {
  /** the status the writer checks first, when it compares the field to exactly one */
  from?: string;
  to: string;
  /** node id of the function that writes it */
  by: string;
  /** how it writes: `x.status = 'A'`, an update call's patch, a SQL `UPDATE … SET status = 'A'` */
  via: 'assignment' | 'update-call' | 'sql';
  /** the write's line in the writer's file */
  line?: number;
}
export interface LifecycleSource {
  /** a SQL CHECK on the column, a `const … as const` array, a `z.enum`, a string-literal union, a TS `enum` */
  kind: 'sql-check' | 'const-array' | 'zod-enum' | 'union' | 'ts-enum';
  name?: string;
  path: string;
  line: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  lang?: string;
  loc?: Loc;
  docs?: string;
  signature?: string;
  /** First lines of the implementation — code lens preview. Code is the source of truth. */
  snippet?: string;
  /** Logical group (JSDoc @group, or file-derived). Groups collapse in the GUI and expand on demand. */
  group?: string;
  tags: string[];
  /** Decision points inside a function/component/route body — Journey forks. */
  branches?: BranchPoint[];
  /** route nodes only: what an OpenAPI/Swagger spec declares about this endpoint + drift vs the code. */
  contract?: OperationContract;
  /** harvested references that are links (`@see <url>`, `@design`) — rendered as anchors, never as prose */
  links?: NodeLink[];
  /** page/component nodes: the design this screen was built from (or should be) — see DesignRef */
  design?: DesignRef;
  /** test nodes only: level/runner/suite and the last observed run — see TestRef */
  test?: TestRef;
  /** external nodes only: which third-party system this is and how we knew it — see ExternalRef */
  external?: ExternalRef;
  /** table nodes, and external nodes that are stores: the data store this lives in and how we know — see StoreRef */
  store?: StoreRef;
  /** table nodes: the statuses one field of the record holds and the functions that move it between them — see RecordLifecycle */
  lifecycle?: RecordLifecycle;
  /** component/page nodes: the stories that render this component on its own — see StoryRef */
  stories?: StoryRef[];
  /** package nodes only: which dependency this is, where it is declared and at what range — see PackageRef */
  package?: PackageRef;
  /** every node under a workspace project's root: which project, its type and its tags — see ProjectRef */
  project?: ProjectRef;
  /** Lens-specific presentation data, e.g. business-friendly labels. */
  facets?: {
    /** label overrides the business-lens name (glossary); description is the plain-language summary (@business). */
    business?: { label?: string; description?: string };
  };
}

// ── resolution: how do we know this edge exists, and how sure are we ──
// Types land here in P1 because the frozen diff contract (farsight-diff v1)
// carries them; adapters start stamping every edge in P4.
export type ResolutionTechnique =
  | 'static-import' //   HIGH   — importer resolved on disk / tsconfig paths / workspace pkg
  | 'fetch→route' //     HIGH   — client call site stitched to a route by method+path
  | 'db-builder' //      HIGH   — Drizzle/JPA builder chain or repository method
  | 'annotation-scan' // HIGH   — @guard/@entrypoint/@covers, Spring annotations
  | 'raw-sql' //         HIGH   — the table name was read out of a SQL statement the code runs (shared/sql.ts)
  | 'same-file' //       HIGH   — the callee is declared in the caller's own file (a sibling function, this.method())
  | 'jsx-render' //      HIGH   — the rendered component is a JSX element written in the caller's own body
  | 'DI-binding' //      MEDIUM — Java field-type → implementing bean
  | 'detected' //        MEDIUM — the adapter recognised the edge from a shape (a middleware name, a file convention); nobody declared it
  | 'import-resolution' // MEDIUM/HIGH — a test's import of the symbol it exercises (HIGH when it also calls it)
  | 'route-literal' //   MEDIUM — a string literal in a test (page.goto('/x'), request.post('/x')) matched to a page/route
  | 'coverage-report' // HIGH   — a coverage/results report observed the node executing
  | 'method-name' //     MEDIUM — a member call resolved to the one class method of that name (mock / in-memory twins set aside)
  | 'interface' //       MEDIUM — a member call resolved through the receiver's declared type to its production implementer
  | 'hook-binding' //    MEDIUM — this.<field>.<path>.<fn>() resolved to the function expression bound at `new C({ … })`
  | 'sdk-import' //      MEDIUM — a function that uses an imported SDK binding reaches the SDK's system
  | 'constant-host' //   MEDIUM — a non-literal fetch inside a class whose base URL starts with a constant host
  | 'name-match' //     LOW    — last-resort symbol name match
  | 'work-key' //        MEDIUM — a work-item key read from a commit subject, a branch name or a tracker URL (core/work-graph.ts)
  | 'callback-prop'; //  MEDIUM — a function a parent hands a single-site child component as a prop, credited to the child that runs it (parsers/src/callback-props.ts)

export type ConfidenceTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface EdgeResolution {
  status: 'resolved' | 'heuristic' | 'unresolved';
  technique: ResolutionTechnique;
  confidence: ConfidenceTier;
  /** unresolved only: what we considered and rejected/couldn't reach. May be empty — that is the point. */
  candidates?: string[];
  /** resolved/heuristic only: the other implementers an interface/hook resolution set aside (doubles included) — never walked, always printed */
  alternatives?: string[];
  note?: string;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  /**
   * Adapter-specific facts about the edge. Three keys are part of the shared
   * contract (the clarity-phase plan §1):
   * - `deferred: true` — the edge was made inside a function expression that is
   *   an object-literal property value (a hook, a callback stored for later);
   *   journeys do not descend it, `impact_of` reports it separately.
   * - `origin: 'setup'` — the edge leaves the setup closure (container
   *   construction); journeys print the boot once instead of under every request.
   * - `tx: true` — the edge was made inside a withOps/withTenant/withTx callback
   *   (the drill's transaction boundary).
   */
  meta?: Record<string, string | number | boolean>;
  /** absent === legacy/unstamped (adapters stamp every edge from P4 onward) */
  resolution?: EdgeResolution;
}

/** A saved or derived subgraph — a "quest" in the GUI. */
export interface Flow {
  id: string;
  name: string;
  entryIds: string[];
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * The farsight.config.json files one source holds and what came of them
 * (docs/proposals/journey-organisation-and-config-files.md §5.3). The root file speaks for the
 * whole source; a nested (scoped) file only for the code under its folder, with its paths
 * relative to that folder.
 */
export interface ConfigMeta {
  /** root first, then by folder depth, then by path; `fields` = the keys the file gave, `ignored` = the ones not applied */
  files: { path: string; dir: string; root: boolean; fields: string[]; ignored: string[] }[];
  /** two files said different things about one key; `kept` is the file whose word stands */
  conflicts: { kind: 'glossary' | 'guard' | 'external' | 'store' | 'tag'; key: string; files: string[]; kept: string }[];
  /** unreadable files, ignored root-only fields, paths that left the source */
  notes: string[];
}

/** What a language adapter returns for one repo. */
export interface GraphFragment {
  repo: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Freshness signal: how many source files were parsed, a hash over their paths+mtimes
   * (`sourceHash`), and a hash over their contents (`sourceDigest`) — the digest is what a
   * reporter must stamp for "unchanged since the run" to be provable (files.ts contentDigest).
   */
  meta?: { files: number; sourceHash: string; sourceDigest?: string; tests?: TestsMeta; stories?: StoriesMeta; stores?: StoresMeta; packages?: PackagesMeta; projects?: ProjectsMeta; config?: ConfigMeta; journeys?: JourneysMeta };
  /** OpenAPI documents that were found but could not be read — reported, never fatal. */
  specErrors?: string[];
  /** true when a farsight.config.json (at the root or nested) was applied by ingestRepo */
  configApplied?: boolean;
}
