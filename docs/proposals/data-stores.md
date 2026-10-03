# Data stores — which store a record lives in, and externals the app uses as stores (proposal, 2026-10-03)

**Status:** agreed on 2026-10-03 as a follow-up to the Map view (`map-view.md`); two lanes (§6).

## 1. The ask

On the street, the plumbing under a screen shows what each call reads and writes. Today every record is a bare
*record* and every external is a *third party* drawn as a write. A reader looking at the reference app cannot tell that
the invoices table lives in **Postgres** while the purchase invoice goes to **Business Central**, which the application
treats as a data store: it reads from it and writes to it. The plumbing must **name the store** a record lives in and
**draw a store-like external with its reads and writes**, in the same anatomy as a record.

## 2. What the graph knows today (survey 2026-10-03)

- A `table` node has no store. Table ids are `${repo}::table::${name}`; the diff contract keys on that id and on
  `signature` (columns), so neither may change.
- The TS/JS adapter already sees the engine and drops it: `pgTable` / `mysqlTable` / `sqliteTable` factories
  (`tsjs.ts:445`), and the `pg` SDK import is recognised with `node: false` (`tsjs.ts:37`). Raw SQL and `db.<table>.<op>`
  chains name the table only. Java JPA entities name the table only.
- `ExternalDecl { import, name, kind }` with `ExternalKind = erp | ocr | files | email | queue | db | http`, never
  validated. Every external edge is `http` with `meta.method` from `fetchMethod()`, which **defaults to GET** when the
  method is not a string literal, and a declared client class gets **one edge from its private `request` method**, so
  the reference app's ERP client, whose ten public methods funnel into one `request({ method })`, is one GET edge.
- In the journey, `SegmentMarker.op` (`reads` | `writes`) is set only for `reads`/`writes` edges; external markers
  never carry it. `SystemRow` keys `records` and `external:<name>` are pinned by tests and by the e2e "5 systems".
- The viewer's `dataMode()` maps a missing direction to **write**.

## 3. Design

### 3.1 `store` on nodes (additive)

```ts
// packages/core/src/graph.ts, next to `external?`
export interface StoreRef {
  name: string;                                  // the store's name in words: 'Postgres', 'Business Central', 'Azure Blob Storage'
  kind: 'sql' | 'document' | 'files' | 'erp' | 'other';
  engine?: 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'mongodb';
  via: 'factory' | 'sdk' | 'datasource' | 'jpa' | 'config';   // how we know — code first, config last
  ref?: string;                                  // 'pgTable' · 'pg' · 'schema.prisma' · 'spring.datasource.url' · the config entry
}
// GraphNode: store?: StoreRef;      — on table nodes, and on external nodes that are stores
// ExternalRef: store?: true;        — this external is used as a data store
// ExternalDecl (farsight.config.json externals[]): store?: boolean;   — override the default from the kind
```

How a table gets its store, in order; the first that applies wins, and nothing is guessed:
1. **factory** — `pgTable` → Postgres/sql/postgres, `mysqlTable` → MySQL, `sqliteTable` → SQLite.
2. **sdk** — exactly one SQL driver imported anywhere in the repo (`pg`, `pg-promise`, `postgres`, `mysql2`, `mysql`,
   `better-sqlite3`, `sqlite3`, `mssql`, `tedious`, `oracledb`): every table node in the repo gets that store. Two
   different drivers → nothing from this rule (say so in `meta`), the config can name it.
3. **datasource** — `schema.prisma` `datasource { provider }` when present (cheap to read; implement if under an hour).
4. **jpa** — Java: `spring.datasource.url` in `application.properties` / `.yml` → engine from the jdbc prefix.
5. **config** — `farsight.config.json` gains `stores?: { name; kind; engine?; tables?: string[] }[]`. Without
   `tables` it names the store of every table the code left unnamed; with `tables` it names only those. Config never
   overrides what code found (principle 2); it fills the gap and is `via: 'config'`.

**Externals as stores.** Default from the kind: `erp`, `db`, `files` are stores; `ocr`, `http` are not; `email` and
`queue` stay messages. `ExternalDecl.store` overrides either way. A store-like external node gets
`store: { name: <external name>, kind: erp | files | other, via: 'config', ref: <import> }`.

### 3.2 Direction for externals (reads and writes)

- In a declared client class, **each public method gets its own `http` edge** to the external, with `meta.method`
  taken from the first string-literal `method:` found on the path from that method to the `fetch` (directly, or through
  one private helper such as `request({ method: 'PATCH', … })` called with an object literal). No literal → `method`
  is omitted (never defaulted to GET). `fetchMethod()` itself stops defaulting to GET when the method is not a literal.
- In the journey (`query.ts` where `op` is set), an external marker gets `op: 'reads'` for GET/HEAD, `'writes'` for
  POST/PUT/PATCH/DELETE, nothing when unknown. `summary.system.externals[]` gains `ops` like records have.
- The row keys stay: `records` and `external:<name>` (the band, the ladder and the e2e "5 systems" are untouched).
  `SystemRow` and `SegmentMarker` gain `store?: { name, kind }` for record markers and store-like external markers.
  `summary.system.stores: { name; kind; records: number; ops: ('reads'|'writes')[] }[]` lists the stores the journey
  touches, for counts.

### 3.3 The street and the property

- A data node's kind line becomes **`<store name> · record`** (or `· files`, `· store` for an ERP) when the store is
  known, else `record` as today; a store-like external is drawn in the record anatomy (left bar by store kind: sql
  violet, erp amber, files cyan-grey, other dim) with its `reads` / `writes` / `reads · writes` word, or **`reached`**
  (new catalog word: *the direction was not recorded*) when the method is unknown — never *writes* by default.
- The legend lists the **stores present in the journey** with their swatches, after the services.
- The explore card for a record or store names the store and how it is known (`via`) in the hybrid register.
- The property's APIs tab *Records this screen reaches* becomes *Data this screen reaches*, grouped by store, the
  external stores included with their modes.
- Business register: store names are product names or config words (a person wrote them); the `via` and `ref` are code
  words and hide.

## 4. Fixture

`examples/invoice-app` uses a hand-rolled `db` object (no driver), so its tables get no store from code; its
`farsight.config.json` gains `stores: [{ name: 'Invoice DB', kind: 'sql', engine: 'postgres' }]` so the e2e sees a
named store through the config route (`via: 'config'`). Its `ErpClient.request` uses a literal `method: 'POST'`
already; add one read method (`getStatus(id)`, GET) and call it from `finalizeInvoice` only if the journey counts the
lanes pin do not move — otherwise leave the fixture's calls alone and test reads on a unit fixture.

## 5. Numbers and words

New counts: *stores touched* on the journey cover and the screen chip row only if typed as `Counted`
(`summary.counted.stores`), listed in `docs/COUNTS.md`; the data-node fold counts are unchanged. New catalog keys under
`map.store.*` (kind words, `reached`, the legend heading, the property heading) with `define`s. No new absence word
and no new evidence class.

## 6. Lanes

| lane | branch | owns | done when |
|---|---|---|---|
| **P — parsers and core** | `feat/data-stores-core` | `core/graph.ts`, `core/config.ts`, `core/query.ts` (+ `journey-counted.ts` for `counted.stores`), `parsers/src/tsjs.ts` (+ `shared/`), `parsers/src/java/*` for the jpa rule, their tests, the fixture config + any fixture change, `docs/MAP-PACKAGES.md`, a captured `/api/journey` JSON for lane V under `packages/server/test/fixtures/` | table nodes in the fixture and in a unit repo carry `store`; the ERP external is a store with per-method edges and methods; journey markers carry `store` and `op` for externals; every existing test and the golden diff pass unchanged; `pnpm -r test` green |
| **V — viewer** | `feat/data-stores-map` | `lib/map-model.js`, `surfaces/map.js`, `lib/map-property-model.js`, `surfaces/map-property.js`, `strings-map.ts`, the map CSS blocks, `e2e/tests/map-*.pw.spec.ts`, `docs/MAP-VIEWER.md` `## MAP`, `docs/COUNTS.md` `### Map` | the street names stores on data nodes, lists them in the legend, draws the ERP with reads and writes and `reached` when unknown; the property groups data by store; business register prints no identifier; e2e green |

Lane V starts from the contract above with a hand-edited copy of the captured billing-cycle fixture, then merges lane
P's branch when P pushes the core types and the real captured JSON. The lead merges P first, then V after it merges
`main`.
