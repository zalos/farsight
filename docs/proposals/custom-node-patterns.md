# Custom node patterns, framework aliases, manual nodes, and OpenAPI candidates

*Proposal — 2026-10-29. Status: draft, not started. Asked by the owner: "designate guard, endpoint, etc. with some
grep or regex we could dynamically run and add specific nodes, or just manually add the nodes", and "identify
swagger/openAPI spec JSONs in the project as potential specs and register them; the tool maintains the data in its
configuration."*

## 1. What the parsers offer today, and where each ask falls through

Three seams already carry meaning a person declares rather than the parser finds:

| seam | what it can do | what it cannot do |
|---|---|---|
| doc tags in code — `@guard[tier] label`, `@entrypoint http:VERB /path`, `@business`, `@covers` (`code-parser/src/shared/docs.ts`, read by both adapters) | turn the annotated function into a guard; tag an entry point | nothing without editing the source; nothing for a call shape |
| `farsight.config.json` matchers — `guards`, `entrypoints`, `tags`, `setup`, `gateTiers`, `validators` (`core/src/config.ts applyConfig`) | re-kind an existing `function` node into a guard (calls → `guards` edges), tag entry points, declare a gate on a route the graph already has (`applyRouteGuards`) | a matcher is a **substring of `path name`**: it cannot read a decorator, an annotation, a call's arguments, or a line of text; it can never **create** a route, an external, a queue or a guard from a call site |
| declarations — `externals[]`, `stores[]`, `openapi[]`, `design[]`, `decisions[]` | add third parties, stores, spec-only routes, screens — nodes no code reaches, tagged `declared` or `spec-only` | no generic *node* declaration: a route served by a framework or language Farsight does not read has no door in except an OpenAPI document |
| the adapter registry — `createParser({ adapters })` in `@farsight/code-parser`; Farsight freezes `[tsJsAdapter, javaAdapter]` (`parsers/src/index.ts`) | a library consumer composes its own adapter | not pluggable from a source; and it must stay that way (§2, last row) |

The framework readers are tables of names: Spring's `MAPPING_ANNS` / `SECURITY_ANNS` (`java/spring.ts`), Nest's verb
decorators and `UseGuards` (`nest.ts`), Express's middleware chain names and App Router's file convention (`tsjs.ts`).
A team whose endpoints are Spring-shaped but spelled `@ApiRoute`, or Nest-shaped but spelled `@JsonGet`, or guarded by
`@RequiresRole`, gets functions and nothing else — exactly the owner's case. OpenAPI discovery (`openapi/discover.ts`)
finds a spec by **name** (`openapi.*`, `swagger.*`, `api-spec.*`, anything under `openapi/`) or by content, but the
content sniff runs only on files already under an `openapi/` folder; a `vendor-api.json` with `"swagger": "2.0"` in
`docs/` is invisible, and there is no list of *what looks like a spec but was not applied* and no way to register one
from the tool: today registration means hand-editing the source's `farsight.config.json` (which MCP never writes into,
decision 2026-10-04) or adding a `type: 'openapi'` source to `.farsight/settings.json`.

## 2. Engines surveyed

| option | verdict | why |
|---|---|---|
| **tree-sitter queries** (S-expressions with captures and `#eq?` / `#match?` predicates) over `@vscode/tree-sitter-wasm` 0.3.1 — already a dependency; the bundle ships `typescript`, `tsx`, `javascript`, `java` plus C#, Go, Python, Ruby, Rust, PHP, C++, bash, css, ini; `Language.query()` and `Query.matches()` are in the shipped `web-tree-sitter.d.ts`; `treesitter/harness.ts` already loads grammars | **the engine** | zero new dependencies, every language the bundle has, bounded and non-spawning; the Java adapter is the proof it runs in our ingest |
| **ast-grep** (`@ast-grep/napi` 0.45) — "code with holes" patterns (`router.on($METHOD, $PATH, $$$MW, $HANDLER)`), YAML/JSON rules with `kind`, `inside`, `has`, `regex` constraints | **later, optional** (`engine: "ast-grep"`) | far friendlier to author than S-expressions, and its rule object is plain JSON, so it slots into the same config block; but it is a native napi binary per platform carrying its own copy of the grammars — a second engine beside oxc and tree-sitter for a benefit that is authoring comfort. Decide after the first users write three real rules |
| **Semgrep / Opengrep** | rejected for ingest | a process, Python, a container; Farsight's ingest spawns nothing (`docs/SECURITY.md`; NX's graph is read, never produced). Sentinel already runs Semgrep, inside its pinned container, for scanning — a different product line |
| **CodeQL · Joern** | rejected | heavyweight builds and databases; CodeQL's licence excludes commercial use outside GitHub |
| **plain regex over file text** | **in, as the cheap tier** | what was asked for; right for one-line declarations (`app.route("/x", methods=["POST"])`, `@ApiRoute("GET /x")`), route tables in YAML or `.properties`, SQL DDL, languages with no grammar in the bundle; wrong for anything that spans lines or needs the enclosing declaration, which is why it is MEDIUM confidence and the query tier is HIGH |
| **a custom `LanguageAdapter` loaded from the source's config** (`"adapters": ["./tools/proto-adapter.mjs"]`) | **never** | that is executing code from a scanned repository at ingest — the supply-chain hazard the no-spawn rule exists for. A consumer who needs a real adapter composes one in their own process with `createParser({ adapters })`; a source declares *data*, never code |

## 3. Design: four config blocks, one engine, one evidence word

Everything below is `farsight.config.json` data, read by `loadWorkspaceConfig` with the same scoping rule as every
other field (the root file speaks for the source, a nested file for its folder), validated by
`schemas/farsight-config.schema.json`, listed in `CONFIG_FIELDS`, reported in `meta.config` and audited by
`declaredPathWarnings` (a declaration that matches nothing is a note with its file and line, never silent).

### 3.1 `frameworks` — aliases the existing readers consume (deepest, cheapest)

"My endpoints are Spring/Nest/Express-shaped under other names." The readers' name tables become functions of the
config; everything downstream — guard mirroring onto delegate handlers, drift, preconditions, the roles table, the
lifecycle — is unchanged because the readers emit the same nodes with the same ids. The owner's two Java shapes are the
worked examples:

- **a policy annotation as a gate** — `@SomeAnnotationPolicy(resource = "invoice", action = "approve")` on a handler.
  Today it is an annotation the reader does not know, so the method has no gate. Declared as `security`, it becomes a
  guard node named from its pairs, with a tier, and the pair that is the grant goes on the edge's `meta.requires` — which
  is what `core/roles.ts` reads, so the role × action table (`#/roles`, `farsight roles`, MCP `roles`) lists the policy
  beside `@PreAuthorize`;
- **the OpenAPI-generator delegate pattern** — the spec in the repo generates `InvoiceApi` (the interface carrying the
  mapping annotations, usually under an excluded `target/generated-sources`), `InvoiceApiController` and
  `InvoiceApiDelegate`; the team writes `class InvoiceApiDelegateImpl implements InvoiceApiDelegate` and overrides
  `public ResponseEntity<Invoice> getInvoice(String id)`. No annotation is in scanned code, so today the handler is a
  plain function and the spec's route stays `spec-only`. The generator's contract is **`operationId` = method name**, and
  reconcile already keeps `contract.spec.operationId` on every spec route and reads `controllerMethodOf()` against it
  (`core/openapi.ts`). Declared as `delegates`, a class implementing a matching interface is a controller, each public
  override returning `ResponseEntity<…>` whose name equals a spec operation's `operationId` becomes that route's
  handler (`calls` route → method), and the route's contract moves from `spec-only` to `both`.

```jsonc
"frameworks": {
  "spring": {
    // annotation → where the verb and path come from: a fixed verb, a positional argument, or a named pair
    "mappings": {
      "ApiRoute": { "method": "pair:method", "path": "arg:0" },   // @ApiRoute("/x", method = "POST")
      "JsonGet":  { "method": "GET",         "path": "arg:0" }    // @JsonGet("/x")
    },
    // annotation → a guard: the label from its arguments, the tier, and which argument is the grant (→ meta.requires)
    "security": {
      "RequiresRole":         { "label": "role: $0",               "tier": "policy",   "requires": "$0" },
      "SomeAnnotationPolicy": { "label": "$action on $resource",   "tier": "policy",   "requires": "$action" },
      "TenantScoped":         { "label": "tenant",                 "tier": "technical" }
    },
    // implemented interfaces whose public ResponseEntity overrides are route handlers, joined to the spec by operationId
    "delegates": ["*ApiDelegate"],
    "listeners": { "OnEvent": "pair:topic" }                       // → consumes edges, like @KafkaListener
  },
  "nest": {
    "verbs":  { "JsonGet": "GET", "JsonPost": "POST" },
    "guards": { "UseTenant": { "label": "tenant", "tier": "technical" } }
  },
  "express": {
    "middleware": { "requireRole": { "label": "role: $0", "requires": "$0" }, "withTenant": { "label": "tenant" } }
  }
}
```

`$0`, `$1` are positional arguments, `$name` a named pair; a label with an unfilled hole prints the annotation's name.
Evidence: `annotation-scan`, HIGH, the note names the alias (`@SomeAnnotationPolicy read as a gate by
farsight.config.json → frameworks.spring.security`); the delegate join is `annotation-scan` HIGH too when the method
name equals the operationId (the generator's contract, no guess), and a delegate override with no matching operation is a
`meta.routes.gaps` entry (`kind: 'delegate-unmatched'`), never a route. The join needs two small reader additions: the
class node records its `implements` list (the reader already reads `super_interfaces`, only for repositories), and the
join runs where reconcile runs, after the spec pass, so it sees the operations. A parser change, so it is measured on a
real ingest against a `main` build.

### 3.2 `patterns[]` — a match becomes a node (the general tier)

"My framework is nothing like those." A post-pass, `parsers/src/patterns.ts`, runs **after the adapters and before the
spec pass** (where `applyWorkspaceConfig` runs today, so drift sees a pattern route), reads only the files a rule's
`files` globs select (the workspace excludes apply; nested configs scope to their folder; ≤ 1 MiB a file, the
`decisions.ts` bound), and joins every match to the graph by span.

```jsonc
"patterns": [
  {
    "id": "koa-router",
    "files": ["src/api/**/*.ts"],
    "match": { "call": "router.$METHOD", "args": { "path": 0, "handler": -1 } },   // sugar → a tree-sitter query
    "emit":  { "kind": "route", "method": "$METHOD", "path": "$path", "handler": "$handler" }
  },
  {
    "id": "legacy-guard",
    "files": ["src/**/*.ts"],
    "match": { "call": "assertRole", "args": { "role": 0 } },
    "emit":  { "kind": "guard", "name": "role: $role", "guards": "enclosing", "tier": "policy" }
  },
  {
    "id": "proto-endpoint",
    "files": ["services/**/*.java"],
    "match": { "annotation": "Endpoint", "args": { "verb": "pair:method", "path": 0 } },
    "emit":  { "kind": "route", "method": "$verb", "path": "$path", "handler": "enclosing" }
  },
  {
    "id": "route-table",
    "files": ["config/routes.yaml"],
    "match": { "regex": "^\\s*-\\s*(?<method>GET|POST|PUT|DELETE)\\s+(?<path>/\\S+)\\s+->\\s+(?<handler>[\\w.]+)" },
    "emit":  { "kind": "route", "method": "$method", "path": "$path", "handler": "$handler" }
  },
  {
    "id": "raw-query",
    "files": ["src/**/*.ts"],
    "match": { "query": "(call_expression function: (member_expression property: (property_identifier) @fn) arguments: (arguments (string (string_fragment) @path)) (#eq? @fn \"get\"))" },
    "emit":  { "kind": "route", "method": "GET", "path": "$path", "handler": "enclosing" }
  }
]
```

**Matchers.** Four, all compiled to the one engine except the last:

- `call` — callee text (`router.$METHOD` captures the member as a variable; `assertRole` is literal), arguments by
  position (`0`, `-1` = last) read as a string literal, an identifier, or a member path;
- `decorator` (TS/JS) and `annotation` (Java) — by name, arguments by position or `pair:name`;
- `query` — a raw tree-sitter S-expression for whatever the sugar does not reach; captures are the variables;
- `regex` — a JavaScript regular expression with named groups, run per line of the file's text.

**Emit.** `kind` ∈ `route · guard · external · queue · rule · flag · entrypoint`. Ids follow the readers' own shapes so
a pattern route merges with the same route from a spec or a `fetch→route` stitch
(`${repo}::route::${METHOD} ${normalizePath(path)}`; `${repo}::guard::${label}`; `${repo}::external::${name}`;
`${repo}::queue::${topic}`). Edges by kind: a route `calls` its handler; a guard `guards` its `handler` or
`enclosing` node; a queue `publishes`/`consumes`; a rule `validates`; `entrypoint` only tags. `enclosing` = the
innermost graph node whose `loc.line…endLine` holds the match (the join `decisionSites` already does). A `$handler`
capture resolves to a node declared **in the same file** by name, else to a `Class.method` of the file's class; an
unresolved handler is recorded, never a `?` stub. Every node gets `tags: [..., 'pattern:<id>']`, `loc` at the match,
`snippet` = the matched text; `business` on the rule becomes `facets.business.description`.

**Evidence.** One new `ResolutionTechnique`, `config-pattern` — `query`/`call`/`decorator`/`annotation` matches
HIGH, `regex` MEDIUM — the note names the rule (`matched by farsight.config.json → patterns[koa-router] at
src/api/x.ts:40`). Additive to `farsight-diff v1` (the enum-pin test in `core/test/diff.test.ts` and
`schemas/farsight-diff-v1.schema.json` grow by one member; a consumer prints an unknown member verbatim).

**Report.** `meta.patterns[]` per rule — `matched`, `nodes`, `edges`, `unresolved[]` (file:line + the capture),
`skipped` (too large, grammar missing) — as `Counted`s in `docs/COUNTS.md`; printed by `farsight config list`,
Settings → Config files, MCP `config_files` and one `graph_overview` line. A rule that matched nothing is a
`declaredPathWarnings` note like any other declaration.

**The loop the owner asked for.** `farsight patterns test [--rule <id>] [--repo <r>] [--json]` runs the rules over
the source without writing the graph and prints every match as `file:line · captures · would emit <kind> <name> →
<handler | unresolved>`. Write a rule, run the command, adjust, then sync. MCP gets the same as a read-only `patterns_test`
in the `all` tier.

**Bounds.** A regex is capped at 512 characters and 64 rules a source; the pass checks a per-rule time budget between
files and stops that rule with a note (no regex timeout exists in Node; the file-size and glob bounds are the real
limit). Queries are bounded by construction. Nothing is spawned; nothing outside the source is read. `docs/SECURITY.md`
gets the paragraph.

### 3.3 `nodes[]` — a node by hand

For the route, guard, external or queue no reader and no pattern can reach (a Perl CGI, a gateway rule, a lambda whose
code is in another repo):

```jsonc
"nodes": [
  {
    "kind": "route", "name": "POST /legacy/invoice",
    "loc": "legacy/handlers.pl:40",                 // optional; audited: a file no adapter indexed is a note
    "handler": "src/bridge.ts::relayInvoice",       // optional; a node id or `path::name`; unresolved = a note
    "guards": ["session"],                          // guard labels: the config's `guards` keys or `nodes[]` guards
    "business": "A supplier posts an invoice from the legacy portal."
  },
  { "kind": "guard", "name": "session", "tier": "policy", "business": "A signed-in supplier." }
]
```

Tagged `declared` with technique `annotation-scan`, exactly what config route guards are today; a person said it, the
parser saw nothing. Journeys walk through it, drift counts it as code-side when the spec declares it, the business
register prints its sentence. No raw `edges[]` in v1 — the three fields above imply every edge a hand-made node needs.

### 3.4 OpenAPI candidates and registration (the second ask)

**Discovery widens, the graph does not move.** `discover.ts` sniffs every `.json` / `.yaml` / `.yml` the collector
selects (the excludes apply; ≤ 8 MiB; the first 2 KiB must carry a top-level `openapi` or `swagger` key before a
parse). Each parsed document is classified: **applied** — named like a spec, under `openapi/`, or declared (today's set,
so every existing graph stays byte-identical); **candidate** — parses as a spec, is none of those, and is **not**
applied. `meta.openapi: { applied[], candidates[] }`, each entry `{ path, title, version, operations, origin }`.

**Surfaces.** `farsight api list` gains a *candidates* section and `farsight api candidates [--repo r] [--json]`;
Settings → Config files lists them per source with a *Register* door; MCP `config_files` and `graph_overview` print
`2 documents look like OpenAPI specs and are not registered: docs/vendor-api.json · tools/mock/swagger-old.json`.

**Registration lives in Farsight's own configuration.** `.farsight/settings.json → sources[].openapi[]`, the same
entry shape as `farsight.config.json → openapi[]` (`path | url`, `name`, `phase`), plus `sources[].openapiIgnore[]` for
a dismissed candidate. `ingestRepo` takes `options.openapi` and merges it with the repo config's (the `merge()` that
`externals` and `plumbing` already use). Writers:

- `farsight api register <source> <path|url> [--name] [--phase]` and `farsight api dismiss <source> <path>`;
- `POST /api/sources/<id>/openapi` / `DELETE …` (through `settingsProblem`, `[data-write]`, refused read-only), then
  `POST /api/sync`;
- the Settings button, which calls the route;
- `--into-source` on the CLI writes `farsight.config.json → openapi[]` instead, for a person who wants the declaration to
  travel with the repository. MCP stays read-only: it lists candidates and prints the command.

A registered document is reported with `origin: 'settings'` beside `file` and `config`, so a reader can tell which
configuration holds it. A URL registered here is read the way `openapi[].url` is today (the API itself serving its spec).

## 4. Plan — four lanes, in this order

| lane | files | gate |
|---|---|---|
| **D — OpenAPI candidates + register** (smallest, the literal second ask) | `parsers/src/openapi/discover.ts` (classify; `origin: 'settings'`), `graph.ts` `meta.openapi` + `schema.ts` regen, `parsers/src/index.ts` `options.openapi`, `server/src/index.ts` (`Source.openapi`, `openapiIgnore`, `settingsProblem`, the two routes, sync merge), `cli/src/cli.ts` (`api candidates|register|dismiss`), `public/app/surfaces/settings-config.js`, `mcp/src/config-tools.ts`, `strings-config.ts`, COUNTS.md, `.farsight/settings.example.json` | unit tests on classification (a named spec, a sniffed candidate, a declared missing one, an ignored one); the discover change proven byte-identical on this repo's and the reference app's graphs (no new `applied`); e2e: register from Settings on the two-source fixture → the route appears after sync; read-only greys the button |
| **A — framework aliases** | `core/src/config.ts` (`frameworks`, `CONFIG_FIELDS`), `schemas/farsight-config.schema.json`, `java/spring.ts` (`mappingsOf(config)`, `securityOf`), `nest.ts` (verb and guard tables from options), `tsjs.ts` (middleware names), `code-parser/src/types.ts` (`AdapterOptions.frameworks`), `parsers/src/index.ts` (pass it like `externals`; `joinDelegates` after `applySpecs`), new `parsers/src/openapi/delegates.ts`, `graph.ts` (`RouteGap.kind` +`delegate-unmatched`), `examples/spring-invoice-api` gaining one `@ApiRoute` endpoint, one policy-annotated handler and a generated-style `*ApiDelegate` implementation, `invoice-app` one aliased Nest verb | parser tests per reader and for the join (operationId match · no match · no spec); `farsight roles` lists the policy's grant; the real-ingest comparison against `main` (identical node and edge sets on this repo; the fixture endpoints are the only delta); `config list` prints the aliases |
| **B — patterns** | new `parsers/src/patterns.ts` + `code-parser/src/treesitter/queries.ts` (`Language.query` behind the harness, grammar by extension), `core/src/config.ts` (`patterns`), schema, `graph.ts` (`config-pattern`, `meta.patterns`), `diff.test.ts` + `farsight-diff-v1.schema.json` (+1 member, contract doc line), `cli.ts` (`patterns test`), `mcp` (`patterns_test`, `config_files`), Settings → Config files, `strings-config.ts`, COUNTS.md, SECURITY.md, ADR in ARCHITECTURE.md (a new declared-evidence technique and config contract) | unit tests per matcher (call · decorator · annotation · query · regex), the span join, same-file handler resolution, the unresolved note, the bounds; an e2e that a pattern route reaches the Map and the APIs page; the real-ingest comparison (no rules in this repo → identical) |
| **C — manual nodes** | `core/src/config.ts` (`nodes`, applied in `applyConfig` before `applyRouteGuards` so a `guards` label can name a hand-made guard), schema, `declared-paths.ts` audit, `strings-config.ts` | unit tests: a route with a handler, one without, a guard label resolved both ways, the audit notes; drift on a declared route that a spec also declares reads `both` |

Each lane is one worktree and one PR (`feat(parsers): …`, `feat(cli): …`), each with the numbers in its body. A and B
both touch `core/src/config.ts` and the schema: A lands first, B rebases. Catalog strings in both registers for every
new word; every number a `Counted`.

## 5. Code samples

### 5.1 Spring aliases (lane A) — mappings, policy annotations, the delegate join

```ts
// java/spring.ts
export interface SpringAliases {
  mappings?: Record<string, { method: string; path: string }>;           // 'GET' | 'arg:0' | 'pair:method'
  security?: Record<string, { label: string; tier?: GateTier; requires?: string }>;
  delegates?: string[];                                                  // interface name globs: ['*ApiDelegate']
  listeners?: Record<string, string>;
}
const argOf = (a: Ann, spec: string): string | undefined =>
  spec.startsWith('arg:') ? a.strings[Number(spec.slice(4))] : spec.startsWith('pair:') ? a.pairs.get(spec.slice(5)) : spec;
/** `$0` → the first positional argument, `$name` → the named pair; a hole nothing fills leaves the template unfilled. */
const fillAnn = (tpl: string, a: Ann): string | undefined => {
  let missing = false;
  const out = tpl.replace(/\$(\d+|\w+)/g, (_, k) => { const v = /^\d+$/.test(k) ? a.strings[Number(k)] : a.pairs.get(k); if (v == null) missing = true; return v ?? ''; });
  return missing ? undefined : out;
};

export function routeMapping(anns: Ann[], aliases: SpringAliases = {}): { method: string; path: string; alias?: string } | null {
  for (const a of anns) {
    const verb = MAPPING_ANNS[a.name];
    if (verb) return { method: verb, path: annString(a, 'value', 'path') ?? '' };
    if (a.name === 'RequestMapping') { /* unchanged */ }
    const alias = aliases.mappings?.[a.name];
    if (alias) {
      const method = (argOf(a, alias.method) ?? 'GET').replace(/^RequestMethod\./, '').toUpperCase();
      return { method, path: argOf(a, alias.path) ?? '', alias: a.name };
    }
  }
  return null;
}

/** Every security annotation on a method or its class: the built-ins as today, the aliases with their label, tier and grant. */
export function securityGuards(anns: Ann[], aliases: SpringAliases = {}): { ann: Ann; label: string; tier?: GateTier; requires?: string; alias?: string }[] {
  return anns.flatMap((a) => {
    if (SECURITY_ANNS.has(a.name)) return [{ ann: a, label: a.strings[0] ?? a.pairs.get('value') ?? '' }];
    const alias = aliases.security?.[a.name];
    if (!alias) return [];
    return [{ ann: a, label: fillAnn(alias.label, a) ?? a.name, tier: alias.tier, requires: alias.requires ? fillAnn(alias.requires, a) : undefined, alias: a.name }];
  });
}
```

In `java/index.ts extractMethods`, the guard loop reads `securityGuards([...anns, ...classAnns], aliases)`: the node gets
`gateTier: { tier, from: 'config' }` when the alias names one, the `guards` edge carries `meta.requires` when the alias
names the grant, and the resolution note says `@SomeAnnotationPolicy read as a gate by farsight.config.json →
frameworks.spring.security`. The class pass records `implements` on the class node (`meta`-free: a `signature`
line `implements InvoiceApiDelegate`, and a tag per interface, `implements:InvoiceApiDelegate`, so the join below is a
lookup).

```ts
// parsers/src/openapi/delegates.ts — after applySpecs, once the spec routes carry their operationId
const RESPONSE_ENTITY = /\bResponseEntity\s*</;
export function joinDelegates(fragment: GraphFragment, globs: string[]): RouteGap[] {
  const gaps: RouteGap[] = [];
  if (!globs.length) return gaps;
  const res = globs.map(globToRegExp);
  const delegateClasses = new Set(
    fragment.nodes.filter((n) => n.kind === 'class' && n.tags.some((t) => t.startsWith('implements:') && res.some((re) => re.test(t.slice(11))))).map((n) => n.name),
  );
  if (!delegateClasses.size) return gaps;
  const byOperationId = new Map<string, GraphNode>();
  for (const n of fragment.nodes) if (n.kind === 'route' && n.contract?.spec?.operationId) byOperationId.set(n.contract.spec.operationId, n);
  for (const fn of fragment.nodes) {
    if (fn.kind !== 'function' || fn.lang !== 'java' || !fn.signature || !RESPONSE_ENTITY.test(fn.signature)) continue;
    const [cls, method] = fn.name.split('.');
    if (!cls || !method || !delegateClasses.has(cls)) continue;
    const route = byOperationId.get(method);
    if (!route) { gaps.push({ kind: 'delegate-unmatched', path: fn.loc!.path, line: fn.loc!.line, name: fn.name, text: `${fn.name} returns a ResponseEntity on a delegate, but no operation in the repo's specs is named ${method}; the route is not recorded` }); continue; }
    if (fragment.edges.some((e) => e.kind === 'calls' && e.from === route.id && e.to === fn.id)) continue;
    fragment.edges.push({ id: `dlg${fragment.edges.length}`, kind: 'calls', from: route.id, to: fn.id,
      resolution: { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH', note: `${cls} implements a delegate interface named by farsight.config.json → frameworks.spring.delegates; ${method} is the spec's operationId` } });
    if (route.contract) route.contract.status = 'both';   // reconcile then sees an implemented route: drift, guards, body rules as for any controller
  }
  return gaps;
}
```

The guard that the policy annotation put on the delegate method now sits on a route, so the business register's *who
may* reads `approve on invoice`, and `farsight roles` lists it.

### 5.2 The patterns post-pass (lane B) — the shape of `parsers/src/patterns.ts`

```ts
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { GraphFragment, GraphNode, GraphEdge, PatternDecl, PatternsMeta } from '@farsight/core';
import { normalizePath } from '@farsight/code-parser';
import { grammarQuery } from '@farsight/code-parser/treesitter'; // new: Language.query behind the harness
import { collectFiles, globToRegExp } from './shared/files.js';
import type { WorkspaceConfig } from './shared/config-files.js';
import type { IngestOptions } from './types.js';

const MAX_BYTES = 1024 * 1024;
const GRAMMAR: Record<string, string> = { '.ts': 'typescript', '.mts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript', '.java': 'java' };

interface Match { line: number; endLine: number; text: string; captures: Record<string, string> }

/** The sugar shapes compiled to one tree-sitter query per grammar; `query` is passed through; `regex` has no query. */
function compile(rule: PatternDecl, grammar: string): string | undefined {
  const m = rule.match;
  if ('query' in m) return m.query;
  if ('call' in m) {
    const [recv, member] = m.call.includes('.') ? m.call.split('.') : [undefined, m.call];
    const fn = member!.startsWith('$')
      ? `(property_identifier) @${member!.slice(1)}`
      : `(property_identifier) @fn (#eq? @fn "${member}")`;
    const callee = recv
      ? `(member_expression object: (identifier) @recv property: ${fn} (#eq? @recv "${recv}"))`
      : fn.replace('property_identifier', 'identifier');
    return `(call_expression function: ${callee} arguments: (arguments) @args) @site`;
  }
  if ('decorator' in m) return `(decorator (call_expression function: (identifier) @name arguments: (arguments) @args) (#eq? @name "${m.decorator}")) @site`;
  if ('annotation' in m) return `(annotation name: (identifier) @name arguments: (annotation_argument_list) @args (#eq? @name "${m.annotation}")) @site`;
  return undefined;
}

/** Positional and `pair:` argument reads over the captured argument list (string literal · identifier · member path). */
function argsOf(rule: PatternDecl, args: string): Record<string, string> { /* small, per grammar; omitted */ return {}; }

function runRegex(rule: PatternDecl, text: string): Match[] {
  const re = new RegExp((rule.match as { regex: string }).regex, 'd');
  return text.split(/\r?\n/).flatMap((lineText, i) => {
    const hit = re.exec(lineText);
    return hit ? [{ line: i + 1, endLine: i + 1, text: lineText.trim(), captures: { ...hit.groups } }] : [];
  });
}

async function runQuery(rule: PatternDecl, grammar: string, text: string): Promise<Match[]> {
  const q = await grammarQuery(grammar, compile(rule, grammar)!); // memoized per (grammar, source)
  return q(text).map((m) => ({
    line: m.site.startPosition.row + 1,
    endLine: m.site.endPosition.row + 1,
    text: m.site.text.split('\n')[0]!,
    captures: { ...m.named, ...(m.named.args ? argsOf(rule, m.named.args) : {}) },
  }));
}

const fill = (tpl: string, c: Record<string, string>) => tpl.replace(/\$(\w+)/g, (_, k) => c[k] ?? '');

/** Every rule of every config file over the files it names, joined to the graph by span. In place; returns the report. */
export async function applyPatterns(fragment: GraphFragment, repoRoot: string, options: IngestOptions, ws: WorkspaceConfig): Promise<PatternsMeta> {
  const repo = fragment.repo;
  const report: PatternsMeta = { rules: [] };
  const byPath = new Map<string, GraphNode[]>();
  for (const n of fragment.nodes) if (n.loc?.repo === repo && n.loc.endLine) (byPath.get(n.loc.path) ?? byPath.set(n.loc.path, []).get(n.loc.path)!).push(n);
  const enclosing = (path: string, line: number) =>
    (byPath.get(path) ?? []).filter((n) => n.loc!.line <= line && line <= n.loc!.endLine!).sort((a, b) => b.loc!.line - a.loc!.line)[0];
  const sameFile = (path: string, name: string) => (byPath.get(path) ?? []).find((n) => n.name === name || n.name.endsWith(`.${name}`));
  const addNode = (n: GraphNode) => { if (!fragment.nodes.some((x) => x.id === n.id)) fragment.nodes.push(n); };
  const addEdge = (e: Omit<GraphEdge, 'id'>) => { fragment.edges.push({ id: `pat${fragment.edges.length}`, ...e }); };

  for (const file of ws.files) {
    for (const rule of file.config.patterns ?? []) {
      const row = { id: rule.id, file: file.path, matched: 0, nodes: 0, edges: 0, unresolved: [] as string[], skipped: [] as string[] };
      report.rules.push(row);
      const globs = rule.files.map((g) => globToRegExp(file.dir === '.' ? g : `${file.dir}/${g}`));
      const files = collectFiles(repoRoot, [...new Set(rule.files.map((g) => g.slice(g.lastIndexOf('.'))))], options)
        .map((abs) => relative(repoRoot, abs).replace(/\\/g, '/')).filter((p) => globs.some((re) => re.test(p)));
      for (const path of files) {
        const abs = join(repoRoot, path);
        if (statSync(abs).size > MAX_BYTES) { row.skipped.push(`${path}: larger than 1 MiB`); continue; }
        const text = readFileSync(abs, 'utf8');
        const grammar = GRAMMAR[path.slice(path.lastIndexOf('.'))];
        const matches = 'regex' in rule.match ? runRegex(rule, text)
          : grammar ? await runQuery(rule, grammar, text)
          : (row.skipped.push(`${path}: no grammar for a ${rule.match ? Object.keys(rule.match)[0] : ''} matcher`), []);
        for (const m of matches) {
          row.matched++;
          const c = m.captures;
          const host = enclosing(path, m.line);
          const resolution: GraphEdge['resolution'] = {
            status: 'resolved', technique: 'config-pattern', confidence: 'regex' in rule.match ? 'MEDIUM' : 'HIGH',
            note: `matched by farsight.config.json → patterns[${rule.id}] at ${path}:${m.line}`,
          };
          const loc = { repo, path, line: m.line, endLine: m.endLine };
          const tags = ['pattern:' + rule.id, ...(rule.emit.tags ?? [])];
          const target = rule.emit.handler === 'enclosing' ? host : rule.emit.handler ? sameFile(path, fill(rule.emit.handler, c)) : undefined;
          if (rule.emit.handler && !target) row.unresolved.push(`${path}:${m.line} handler ${JSON.stringify(fill(rule.emit.handler, c))}`);
          switch (rule.emit.kind) {
            case 'route': {
              const name = `${fill(rule.emit.method ?? 'GET', c).toUpperCase()} ${normalizePath(fill(rule.emit.path ?? '', c))}`;
              const id = `${repo}::route::${name}`;
              addNode({ id, kind: 'route', name, loc, snippet: m.text, tags, ...(rule.emit.business ? { facets: { business: { description: fill(rule.emit.business, c) } } } : {}) });
              if (target) { addEdge({ kind: 'calls', from: id, to: target.id, resolution }); row.edges++; }
              row.nodes++; break;
            }
            case 'guard': {
              const name = fill(rule.emit.name ?? rule.id, c);
              const id = `${repo}::guard::${name}`;
              addNode({ id, kind: 'guard', name, loc, snippet: m.text, tags: ['auth', ...tags], ...(rule.emit.tier ? { gateTier: { tier: rule.emit.tier, from: 'config' } } : {}) });
              const guarded = rule.emit.guards === 'enclosing' ? host : target;
              if (guarded) { addEdge({ kind: 'guards', from: id, to: guarded.id, resolution }); row.edges++; }
              row.nodes++; break;
            }
            // external · queue · rule · flag · entrypoint: the same shape with the readers' id forms (omitted)
          }
        }
      }
    }
  }
  return report;
}
```

Wired in `ingestRepo` straight after `applyWorkspaceConfig` and before `applySpecs`; `merged.meta.patterns = report`
when any rule ran. `farsight patterns test` calls `applyPatterns` on a throwaway copy of the fragment and prints the
report with each match's captures.

### 5.3 OpenAPI candidates and the register route (lane D)

```ts
// openapi/discover.ts — classification; today's applied set is unchanged
export interface DiscoveredSpec extends ParsedSpec {
  path: string; text: string; name?: string;
  origin: 'file' | 'config' | 'settings';
  /** applied = named like a spec, under openapi/, or declared · candidate = parses as a spec and is none of those */
  status: 'applied' | 'candidate';
}
const SNIFF_RE = /(^|\n)\s*"?(openapi|swagger)"?\s*:/;
// every .json/.yaml/.yml the collector selects, sniffed on its first 2 KiB; named / under openapi/ / declared → applied; else → candidate
for (const abs of collectFiles(repoRoot, ['.yaml', '.yml', '.json'], options)) {
  const rel = relative(repoRoot, abs);
  if (seen.has(rel) || statSync(abs).size > MAX_BYTES) continue;
  const head = readHead(abs, 2048);
  const named = NAME_RE.test(basename(abs)) || /(^|\/)openapi\//.test(rel);
  if (!named && !SNIFF_RE.test(head)) continue;
  try {
    const text = readFileSync(abs, 'utf8');
    specs.push({ ...parseSpecText(text, rel), path: rel, text, origin: 'file', status: named ? 'applied' : 'candidate' });
  } catch (err) { if (named) errors.push(`openapi ${rel}: ${(err as Error).message.split('\n')[0]}`); }
}
```

```ts
// server/src/index.ts — the source carries what the workspace registered; the sync passes it to ingestRepo
export interface Source { /* … */ openapi?: { path?: string; url?: string; name?: string; phase?: string }[]; openapiIgnore?: string[]; }
// in sync(): ingestRepo(dir, { repoName: source.name, exclude: source.exclude, openapi: source.openapi })

// POST /api/sources/<id>/openapi  { path | url, name?, phase? }   ·   DELETE /api/sources/<id>/openapi?path=…
if (m = url.match(/^\/api\/sources\/([^/]+)\/openapi$/)) {
  if (refuseWrite(req, res, session)) return;                   // read-only / --as-of servers refuse every write
  const src = settings.sources.find((s) => s.id === decodeURIComponent(m[1]!));
  if (!src || (src.type !== 'local' && src.type !== 'git')) return notFound(res, 'no code source with that id');
  const body = await readJson(req);
  const ref = body.url ?? body.path;
  if (typeof ref !== 'string' || !ref || (!isSpecUrl(ref) && (ref.startsWith('/') || ref.includes('..')))) return bad(res, 'path must be source-relative, or a URL');
  src.openapi = [...(src.openapi ?? []).filter((e) => (e.url ?? e.path) !== ref), { ...(isSpecUrl(ref) ? { url: ref } : { path: ref }), ...(body.name ? { name: body.name } : {}), ...(body.phase ? { phase: body.phase } : {}) }];
  src.openapiIgnore = (src.openapiIgnore ?? []).filter((p) => p !== ref);
  const problem = settingsProblem(settings); if (problem) return bad(res, problem);
  saveSettings(ws, settings);
  return json(res, { registered: ref, source: src.id, next: 'POST /api/sync' });
}
```

```sh
farsight api candidates --repo invoice-app          # docs/vendor-api.json · Vendor API 1.4 · 12 operations · not registered
farsight api register invoice-app docs/vendor-api.json --name "Vendor API"   # → .farsight/settings.json sources[].openapi[]
farsight api register invoice-app docs/vendor-api.json --into-source         # → the repo's farsight.config.json openapi[] instead
curl -X POST localhost:4477/api/sync
```

## 6. The GUI

Configuring any of this from the tool — the workspace overlay in `.farsight/settings.json → sources[].config`, the
forms, the pattern Test button, Export to the repository — is [settings-page.md](settings-page.md), whose lanes S1–S3
interleave with D, A, B, C (its §6).

## 7. Left open, on purpose

- `engine: "ast-grep"` as a second matcher syntax — decide after real rules exist; the block's shape leaves the room.
- Cross-file handler resolution for `$handler` (through imports) — v1 resolves in the same file and reports the rest;
  v2 can read the adapter's export index if the artifact exposes it.
- A pattern that *removes* or *re-kinds* a node the parser found (false positives) — a different proposal; today a
  wrong node is corrected by fixing the reader.
- Patterns over the graph itself (a rule matching nodes rather than text) — that is what `tags`/`guards` matchers are;
  if they need more than a substring, give them the same `match` grammar later.
