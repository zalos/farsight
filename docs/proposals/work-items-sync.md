# Work items as a source — Jira and Azure DevOps sync, a local cache, and edit under permissions

**Status:** proposal, 2026-09-27. Not scheduled. Research appendices:
[work-items-sync/research-jira-cloud.md](work-items-sync/research-jira-cloud.md) ·
[work-items-sync/research-azure-devops.md](work-items-sync/research-azure-devops.md) (every API fact below cites
one of them; anything marked UNCONFIRMED there is UNCONFIRMED here).
**Why:** the graph's only source of truth is the code (`docs/AI-HANDOFF.md`, *Direction noted 2026-09-27*). A flow has
a life before its code — a ticket, a story, an epic — and beside it — the comments, decisions and assignments that say
*why* and *who*. Jira and Azure DevOps hold that life for the teams Farsight targets. This proposal brings work
items into the same graph as a **source**, keeps a **local cache** the tool can answer from at any time, treats the
tracker as the **source of truth** it syncs back to, runs in **read-only or edit** mode per source, and in edit mode
lets a consumer grant exactly which actions are allowed — comment, change fields, assign, move state — under one
**permission structure** that is the same regardless of provider.

The bar is the product's bar: *a person who opens Farsight understands the app before they understand the tool.*
Here that reads: **a person who opens a flow sees the work behind it — what was asked, who owns it, where it stands —
without opening Jira**, and an agent can say *this story is in progress, assigned to Vendor Ops, and the code for its
second screen is not built yet* from one graph.

---

## 1 · Principles this obeys, and the one it bends

- **One graph, many lenses (principle 1).** A work item is a node (`kind: 'work'`) in the same graph, carried by a
  fragment the way `design`/`flow` and `api` nodes are. Every consumer — HUD, MCP, CLI — is a view over it. The
  provider is a plugin behind one adapter interface (§4), the way language adapters sit behind `ingestRepo()`
  (`docs/proposals/language-adapters.md`). **No provider ever forks the schema.**
- **Code is the source of truth (principle 2) — bent, not broken.** For what the code *does*, the code stays the truth.
  For what was *asked* and *who answers*, the tracker is the truth and the cache is a replica of it. Where the two
  disagree — a story says *done* and its screen is *not built*; a flow's prose says one thing and the code another —
  the tool shows the disagreement as a **finding with both provenances**, never a silent winner. This is the first
  adapter of the documentation-as-source direction; the file-manifest and other-sink adapters follow the same seam.
- **Two audiences, same nodes (principle 3).** Business readers see the story in the words the tracker uses (title,
  state in words, owner); developers see the key, the branch, the commits. Both through the two-register catalog.
- **Every number is a `Counted`, every absence word is from the closed set, every detail carries a tip.** *not indexed*
  already names exactly what this brings in (*an owner, a design comment*) — after this pass it names less.

---

## 2 · What it is for — the questions it answers

| who asks | the question | the answer's source |
|---|---|---|
| ops owner | *what is being worked on for invoice submission right now, and by whom?* | the flow's linked work items, their state category and assignee, as of the last sync |
| business analyst | *which stories does this screen trace to, and are they done?* | work ↔ screen links, state vs `design.status` (built / design-only) — a finding when they disagree |
| developer | *what ticket is this function for, and what did the discussion decide?* | commit spine (`history.ts`) keys → work item, its comments |
| agent (MCP) | *summarise the open work on this journey; comment on ACME-123 that the seam is built; move it to review* | `work_items`, `work_comment`, `work_transition` — the last two only in edit mode and only when granted |
| everyone | *is this current?* | the freshness sentence: *synced 3 minutes ago · 2 items changed since* / *source unreachable since 09:14, showing the cache* |

---

## 3 · The common structure — `farsight-work v1`

One record shape for every provider, **frozen and additive-only** like `farsight-diff v1`, pinned by a test that
asserts its enums against a literal list and a schema file (`schemas/farsight-work-v1.schema.json`). Providers map
*into* it; nothing maps out of it per consumer. The provider's native record is kept verbatim in `raw` for the
developer register and for write-back, never rendered in the business register.

```ts
interface WorkItem {
  id: string;                        // graph node id: `work::<sourceId>::<key>` — e.g. work::acme-jira::ACME-123
  source: string;                    // the Farsight source id this came from
  provider: 'jira' | 'azure-devops'; // additive: 'github' | 'linear' | 'manifest' later
  key: string;                       // ACME-123 · 4711 (ADO id) — what people say
  url: string;                       // the item's web page
  type: { name: string; category: WorkType };            // name as the tracker spells it; category from the closed set
  title: string;
  body?: Body;                       // description
  state: { name: string; category: StateCategory; since?: string };  // name as the tracker spells it; category closed
  priority?: { name: string; rank?: number };
  assignee?: Person; reporter?: Person;
  labels: string[];                  // Jira labels · ADO tags
  area?: string;                     // ADO AreaPath · Jira component (first) — a place in the product
  iteration?: { name: string; start?: string; end?: string };  // ADO IterationPath · Jira sprint
  parent?: string;                   // WorkItem id
  links: Link[];
  estimate?: { value: number; unit: 'points' | 'hours' | 'days' };
  created: string; updated: string; resolved?: string;   // ISO 8601 UTC
  revision: string;                  // ADO `rev` · Jira `fields.updated` — what compare-before-write checks
  comments: Comment[];
  history: Change[];                 // field changes, newest last
  fields: Record<string, unknown>;   // custom fields by canonical name (§4.3 mapping), values as read
  raw: unknown;                      // the provider's record, verbatim
}
type WorkType      = 'epic' | 'feature' | 'story' | 'task' | 'bug' | 'other';         // closed
type StateCategory = 'todo' | 'in-progress' | 'done' | 'removed';                    // closed — the absence-word rule applies
interface Person   { id: string; name: string; email?: string }   // Jira accountId · ADO descriptor; email may be null (privacy)
interface Body     { format: 'markdown' | 'html' | 'adf' | 'wiki'; raw: unknown; text: string }  // text = plain rendering
interface Link     { kind: 'parent' | 'child' | 'relates' | 'blocks' | 'blocked-by' | 'duplicates' | 'other'; target: string; native: string }
interface Comment  { id: string; author: Person; created: string; updated?: string; body: Body }
interface Change   { at: string; by?: Person; field: string; from?: string; to?: string }
```

**Mapping that must not be guessed** (both appendices):

| fact | Jira | Azure DevOps |
|---|---|---|
| `state.category` | `status.statusCategory.key`: `new` → todo · `indeterminate` → in-progress · `done` → done | `workitemtypes/{type}/states[].category`: Proposed → todo · InProgress → in-progress · **Resolved → in-progress** (name kept; CMMI puts *Resolved* in InProgress for some types — never infer from the name) · Completed → done · Removed → removed |
| `type.category` | `issuetype.name` + `hierarchyLevel` (epic ≥ 1; subtask → task; Bug → bug) | `System.WorkItemType` per process (Epic/Feature → epic/feature; User Story/Product Backlog Item/Requirement → story; Task → task; Bug/Issue → bug) |
| `Person.id` | `accountId` — email may be null, `displayName` mutable | `descriptor` (fallback `id`) — `uniqueName` deprecated, `displayName` non-unique |
| `parent` | `fields.parent` (not the Agile epic endpoints — they fail for team-managed projects) | relation `System.LinkTypes.Hierarchy-Reverse` (`System.Parent` UNCONFIRMED) |
| `iteration` | the Sprint custom field found by `schema.custom = com.pyxis.greenhopper.jira:gh-sprint`, never by name or a fixed `customfield_` id | `System.IterationPath` + team iterations for dates |
| `estimate` | the board's `estimation.field.fieldId` (a plain numeric field) | `Microsoft.VSTS.Scheduling.StoryPoints` / `RemainingWork` (`Effort` UNCONFIRMED) |
| `body` | ADF (v3) — Farsight owns an ADF ↔ markdown converter; there is no plain-text option | HTML by default; markdown per field when `multilineFieldsFormat` says so (one-way, cloud only) |
| `revision` | `fields.updated` (no ETag exists) | `rev` |

**Consistency rule for the categories:** a category is a fact decided once by the provider from the tracker's own
category field, never from a state's name. The HUD, MCP and CLI print the tracker's `state.name` beside the category
word; the category drives colour and the *done / not done* counts.

---

## 4 · Plugin architecture

### 4.1 Packages

```
packages/work/            core: the contract (§3), the cache (§5), the sync engine (§6), the permission gate (§7), the outbox
packages/work-jira/       provider plugin: Jira Cloud (v3 + Agile/Software); Data Center variant flagged, not built
packages/work-azdo/       provider plugin: Azure DevOps Services (7.1; comments 7.2-preview.4); Server variant capped by version probe
```

`packages/work` depends on `packages/core` only. Providers depend on `packages/work` and nothing else in the
workspace. Server, CLI and MCP depend on `packages/work` and load providers through its registry — the same shape as
`parsers/src/index.ts` (adapters array, `ingestRepo()` dispatch). A provider is one directory and one registry line.
Third-party providers later: a package that exports `WorkProvider`, named in settings by module id.

### 4.2 The provider interface

```ts
interface WorkProvider {
  id: 'jira' | 'azure-devops' | string;
  capabilities: Capabilities;                                   // declared, printed, tested — §4.4
  connect(cfg: SourceConfig, secret: Secret): Promise<Session>; // resolves site/org/cloudId, probes version, checks the credential
  discover(s: Session): Promise<Schema>;                        // projects, types (+category), states (+category), fields (+canonical mapping), link types, users?
  pull(s: Session, cursor: Cursor | null, scope: Scope): AsyncIterable<PullPage>;   // full when cursor is null; incremental after — §6
  hydrate(s: Session, ids: string[]): Promise<WorkItem[]>;       // comments + history for changed items (ADO 200/batch · Jira bulkfetch 100/1000)
  can(s: Session, item: WorkItem, action: Action): Promise<ProviderVerdict>;        // the tracker's own answer — §7
  apply(s: Session, intent: Intent): Promise<ApplyResult>;      // one write, provider-native concurrency — §8
}
```

`pull` yields `{ items, cursor, isLast, deleted?: string[] }`. Providers own paging, rate limits (`Retry-After`,
`X-RateLimit-*`, `RateLimit-Reason`, ADO TSTU cost headers — even on a 200), retries with jitter, and version
capping. The engine owns everything else. **A provider never touches the cache and never decides a permission.**

### 4.3 Discovery and the field map

`discover()` runs on connect and again on schedule; its result is cached with the source. It resolves the
site-specific facts §3 refuses to guess: which custom field is Sprint or Story Points (Jira `schema.custom`,
board `estimation.field`), what each state's category is (ADO per type; Jira `statuscategory`), what a type's
transitions are (ADO `transitions` map; Jira per-issue `transitions` with `expand=transitions.fields`). A consumer can
pin or override the map in settings (`fields: { estimate: 'customfield_10016' }`) — pinned entries are printed as
*declared by you*, discovered ones as *found on the site*.

### 4.4 Capabilities — declared, not assumed

```ts
interface Capabilities {
  comments: { read: boolean; write: boolean; format: 'markdown' | 'adf' | 'html' };
  transitions: 'graph' | 'per-item';          // ADO: the type's transition map · Jira: ask per issue
  concurrency: 'revision' | 'compare-updated'; // ADO: `test /rev` · Jira: re-GET `updated` before write, 409 = conflict
  permissionsProbe: 'per-item' | 'per-area' | 'none';  // Jira mypermissions?issueKey · ADO permissionevaluationbatch per area (best effort)
  deletesVisible: boolean;                     // ADO reporting feed with includeDeleted · Jira: only by reconcile scan
  push: 'none' | 'webhook';                    // both 'none' for a desktop tool (§6.3)
  dryRun: boolean;                             // ADO validateOnly=true · Jira: no
}
```

Capabilities are printed on the source card (*comments in markdown · conflicts by revision · deletions seen*) and
drive what the HUD offers — a provider without `dryRun` gets no *preview* button rather than a fake one.

---

## 5 · The local cache — a replica with a cursor and an outbox

`.farsight/work.db`, built-in `node:sqlite`, beside `farsight.db` (ADR 7); same honest degrade when the module is
missing (`WorkCacheUnavailable`: the source reads live, slower, and says so).

| table | holds |
|---|---|
| `source` | id, provider, scope, mode, cursor (opaque per provider: ADO `continuationToken` · Jira last `updated` − overlap), schema (discover result), last sync, last error |
| `item` | the current `WorkItem` per id (JSON) + indexed columns: key, type, state category, assignee id, updated, parent |
| `item_rev` | SCD2 rows like `snapshots.ts`: every version of every item with `first_sync`/`last_sync` — *what did ACME-123 say at sync 12* is an interval query; retention is a DELETE |
| `comment`, `change` | normalised for query; the item JSON carries them too |
| `person` | id → name/email as last seen (display names change; ids do not) |
| `link` | work ↔ graph node links with provenance (§9) |
| `outbox` | intents: id, item, action, payload, requested-by (human/agent + session), state `queued → applying → confirmed | conflict | denied | failed`, provider result, timestamps |
| `audit` | every permission decision and every write, with the three verdicts (§7) — never pruned by retention |

**Source of truth rule.** The cache is never merged with the remote. A pull *replaces* the item with what the tracker
says; a local intent is not a local edit — it is a request the tracker either accepts (then the item is re-read and
replaced) or rejects (conflict/denied, shown, re-basable by a person). There is no offline edit queue that applies
later without a person: an intent that cannot be applied within the session is left `queued` and printed as such.

---

## 6 · The sync engine

### 6.1 Initial and incremental

- **Jira:** page `POST /search/jql` with bounded JQL (`project in (…) AND updated >= "…" ORDER BY updated ASC`) and
  an explicit field list (`fields` defaults to `id`), token pagination, no `total`; changed items get
  `POST /changelog/bulkfetch` and paged comments; deletions and moves by a periodic key-only reconcile scan
  (`fields=id`). Overlap the window by a few minutes (one-minute granularity in the user's time zone), dedupe on
  `id + updated`, and `reconcileIssues` after Farsight's own writes (search is eventually consistent).
- **Azure DevOps:** WIQL for ids then `workitemsbatch` (200) on first pull; then the **reporting revisions feed**
  (`wit/reporting/workitemrevisions`, `continuationToken` as the watermark, `includeDeleted`, `includeLatestOnly`) —
  Microsoft's stated incremental path; a WIQL `System.ChangedDate` poll with `timePrecision=true` is the fallback
  (20,000-row silent truncation, no hard deletes). Comments re-pulled for items whose `ChangedDate` moved.
- Every sync writes a `source` row and `item_rev` intervals, so *Changes* can show work-item history on the same
  spine as code syncs.

### 6.2 Freshness — the words
Every surface that prints a work item prints when the cache last agreed with the tracker, in the existing freshness
grammar: *synced 3 minutes ago* · *source unreachable since 09:14 — showing the cache* · *credential expired — showing
the cache* (Jira API tokens live ≤ 365 days; Entra tokens one hour with silent refresh; global ADO PATs end
2026-12-01). Never a bare timestamp; never a number without its scope.

### 6.3 No webhooks, by design
Both trackers push only to a public HTTPS endpoint (Jira also needs a 3LO app and a 30-day refresh). A desktop tool
has neither, so **v1 polls** on a configurable cadence and honours every rate-limit header. A hosted relay that
receives webhooks and exposes a pull queue is the later upgrade; the provider interface already leaves `push` room
for it.

---

## 7 · Modes and the permission structure

### 7.1 Two modes, per source
`mode: 'read-only' | 'edit'`. Read-only registers no write tools, draws no write controls, holds no outbox — the
HUD prints *read-only* on the source card and every item. Edit mode turns on §7.2–7.4. The default is read-only.

### 7.2 One closed set of actions
`comment` · `edit` (fields) · `assign` · `transition` · `link` · `label` · `create`. No provider adds an eighth; a
provider that cannot do one declares it in `capabilities` and the gate denies it with *this source cannot*.

### 7.3 Three verdicts, ANDed, every one recorded
A write is allowed only when all three say yes, and the audit row carries all three answers:

1. **The consumer's policy** — in `.farsight/settings.json` on the source, evaluated locally, before any call:
   ```json
   "permissions": {
     "default": "deny",
     "grants": [
       { "actions": ["comment"], "principals": ["human", "agent"] },
       { "actions": ["edit"], "fields": ["labels", "estimate", "iteration"], "principals": ["human"] },
       { "actions": ["assign"], "scope": { "projects": ["ACME"], "types": ["story", "task", "bug"] }, "principals": ["human"] },
       { "actions": ["transition"], "to": ["in-progress", "done"], "scope": { "areas": ["the reference app\\Portal"] }, "principals": ["human"], "confirm": "always" }
     ],
     "agentWrites": "confirm"
   }
   ```
   `scope` narrows by project, type category, area/component, current state category; `fields` allow-lists what
   `edit` may touch (in canonical names); `to` allow-lists target state categories for `transition`; `principals`
   is `human` (a person in the HUD or CLI) and/or `agent` (an MCP caller); `confirm: always | agent | never` puts a
   person between the request and the write — `agentWrites: confirm` is the default so an agent never writes to a
   tracker without a person pressing *apply*. Grants are additive; there is no `deny` grant, because *default deny +
   explicit allow* is the only structure a person can read back correctly.
2. **The tracker's own answer** — `can()` asks the provider before applying: Jira `mypermissions?issueKey=` plus
   `expand=operations,editmeta,transitions` (an empty transitions list means *no Transition issues*); ADO
   `permissionevaluationbatch` for the area (best effort) plus `validateOnly=true` as the dry run. Printed as *Jira
   says: yes* / *Azure DevOps says: not on this area*.
3. **The credential's scope** — what the token or grant can do at all (Jira `write:jira-work` or the granular
   scopes; ADO `vso.work_write`), checked at connect and re-checked on 401/403.

The provider's error on the actual write (Jira 400/409/413/422 · ADO 400/403, a failed `test /rev`) is the final
word and is shown as such — pre-checks reduce surprises; they do not replace the answer.

### 7.4 Attribution
Every intent records who asked: `human` (the HUD's signed-in tracker user; every request acts *as that user*, which
is why per-user credentials are the design and there is no shared service identity in v1) or `agent` (the MCP
session id and the tool name). A comment an agent writes is prefixed the way the tracker's users will read it
(*via Farsight (agent)*) unless the policy says `attribution: none`.

---

## 8 · Write-back — an intent, a check, one call, a re-read

```
intent → gate (§7.3) → freshness check → provider.apply() → re-read the item → replace in cache → audit
```

- **Freshness check** before every write: the cached `revision` must still match the tracker's (`compare-updated`
  re-GETs `fields.updated` and the changelog since; `revision` puts `{"op":"test","path":"/rev"}` first in the
  JSON Patch). A mismatch is a **conflict**: the item is re-read, shown beside the intent, and a person re-bases or
  drops it. Never last-writer-wins on a stale copy.
- **One call per intent**, provider-native: Jira `PUT /issue/{key}` with `update` verbs for multi-valued fields
  (labels add/remove, never a replacing `fields.labels`), `POST /comment` with an ADF body from the converter,
  `POST /transitions` with only the transition screen's fields, `PUT /assignee` by `accountId`; ADO one PATCH per
  intent (`System.Tags` as a semicolon string, `System.AssignedTo` as an IdentityRef, `System.State` validated
  against the type's transition map first), `POST …/comments?format=markdown` on 7.2-preview (falls back to `text`
  on 7.1), never `bypassRules` or `suppressNotifications`.
- **Re-read and replace**, then `reconcileIssues` (Jira) so the next search sees the write.
- Per-issue write caps (Jira 20/2 s, 100/30 s) and ADO TSTUs are the provider's problem; the engine serialises
  intents per item.

---

## 9 · Where work meets the graph

A `work` node is only useful joined to the rest. Links carry provenance and a confidence tier like every edge:

| link | how | tier |
|---|---|---|
| work → `flow` / screen | the design manifest's `docs:` URLs or a new `work: ["ACME-123"]` per flow/screen in `screens.json`; `@work ACME-123` in a doc comment (a sixth Farsight tag, alongside `@business`/`@covers`) | HIGH (declared) |
| work → commit → function | keys in commit subjects and branch names (`ACME-123-submit-seam`) on the spine `history.ts` already builds; the commit's files → the nodes it touched | MEDIUM (detected) |
| work → route / page | a URL in the item body that matches a page route or an API path | LOW (name-match) |
| work ↔ work | `parent`, `links[]` — as declared | HIGH |

Edge kind: **`tracks`** (work item → what it is about), added to `EdgeKind` (additive; `farsight-diff v1` carries
edge kinds as strings, so the enum test grows by one literal). The HUD shows, on a flow: *3 stories · 1 in progress ·
2 done · owner Vendor Ops* as `Counted`s; on a step: *tracked by ACME-123 (in progress, Vendor Ops)*. **Findings**
where the two truths disagree, printed with both provenances: *ACME-140 is done; its screen SCR-14b is not built* ·
*ACME-123 is to do; 4 commits name it*.

---

## 10 · Consumers

- **CLI** `farsight work sync|status|list|show <key>|links <key>` (all modes) · `comment|assign|move|edit|link <key>`
  (edit mode; every write prints the three verdicts and the result). `--json` on `list`/`show` is the frozen record.
- **MCP** `work_items` (filter by flow, state category, assignee, updated since), `work_item`, `work_links`; in edit
  mode and only for granted actions: `work_comment`, `work_update`, `work_assign`, `work_transition` — each returns
  the verdicts and, under `confirm`, a *pending your confirmation in the HUD* answer instead of a write.
  `graph_overview` gains the sources' freshness lines.
- **HUD** a WORK surface (source cards with freshness, capabilities and mode; items by flow / state / assignee; the
  outbox and its conflicts), work chips on Portfolio rows and journey headers, an item pane in the journey's inspector,
  and the *apply* / *re-base* / *drop* controls that `confirm` needs. Business register: the tracker's words, never
  keys or field ids; hybrid adds the key; code adds `raw`.
- **Settings** per source:
  ```json
  { "id": "acme-jira", "type": "work", "provider": "jira", "site": "https://acme.atlassian.net",
    "scope": { "projects": ["ACME"] }, "mode": "read-only",
    "auth": { "kind": "api-token", "user": "env:JIRA_USER", "secret": "keychain:farsight/jira-example" },
    "poll": "5m", "fields": {}, "permissions": {} }
  { "id": "acme-azdo", "type": "work", "provider": "azure-devops", "org": "https://dev.azure.com/acme",
    "scope": { "projects": ["the reference app"], "areas": ["the reference app\\Portal"] }, "mode": "edit",
    "auth": { "kind": "entra-device-code", "clientId": "…", "tenant": "…" }, "poll": "5m" }
  ```
  Secrets are never in settings: `env:` or `keychain:` references only. Auth kinds: Jira `api-token` (primary),
  `scoped-token` (needs the cloudId gateway), `oauth-3lo` (later, hosted callback); ADO `entra-device-code`
  (primary), `entra-auth-code` (server), `az-cli` (`az account get-access-token`), `pat` (org-scoped; the Server
  fallback).

---

## 11 · ADRs this adds

10. **The tracker is the source of truth; the cache is a replica with a cursor and an outbox of intents, never a
    merge.** A write is a request the tracker accepts or rejects; the cache only ever holds what the tracker said
    last. Cost: no offline editing. Gain: no divergence a person has to reconcile later, and every number on the
    surface names the sync it comes from.
11. **Providers are plugins that declare capabilities; the core owns the contract, the cache, the engine and the
    gate.** A provider never writes the cache and never decides a permission. Cost: some provider-specific power
    (Jira properties, ADO board columns) stays in `raw`. Gain: one record, one permission grammar, one freshness
    sentence for every tracker.
12. **A write needs three yeses — the consumer's policy, the tracker's own answer, the credential's scope — and the
    audit row keeps all three.** Default deny; agents confirm through a person unless the policy says otherwise.
    Cost: a pre-check round trip per write. Gain: a permission structure a product owner can read back, and an audit
    trail that says who asked, what the tracker said, and what happened.
13. **Polling, not webhooks, for a desktop tool.** Both trackers push only to public HTTPS; the relay is a later
    upgrade behind the same interface.

---

## 12 · Phases

| phase | delivers | done when |
|---|---|---|
| **P0 — contract + core** | `packages/work`: `farsight-work v1` record + schema + enum-pin test; the cache (`work.db`, SCD2 revs, outbox/audit tables); the engine's pull loop against a **recorded-fixture provider** (`work-fixture`: JSON pages on disk, the way `examples/invoice-app` is the e2e fixture — no MSW, ADR 8); freshness words in the catalog; `farsight work sync|list|show` | core tests pin the record; a fixture sync round-trips full → incremental → delete; every printed number is a `Counted` in `docs/COUNTS.md` |
| **P1 — Jira read-only** | `work-jira`: api-token auth, discover (fields by `schema.custom`, status categories, transitions per issue), `search/jql` + bulkfetch + changelog + comments, ADF → markdown/text, reconcile scan, rate-limit headers | a real site syncs into the cache; a second sync is incremental; a deleted issue disappears after the reconcile scan; the source card's freshness sentence is true |
| **P2 — Azure DevOps read-only** | `work-azdo`: Entra device-code (MSAL) + `az` token + org PAT, version probe, discover (types/states/categories/transitions), WIQL + batch, reporting revisions watermark, comments on preview with fallback, HTML/markdown body flag | same acceptance on a real org; Server 2022.1 caps `api-version` to 7.1 and says so |
| **P3 — in the graph** | `work` nodes in the fragment, `tracks` edges (declared via `screens.json`/`@work`, detected via the commit spine), the WORK surface, chips on Portfolio and journeys, MCP `work_items`/`work_item`/`work_links`, the two findings (done-but-not-built, to-do-but-committed) | on the reference app, each flow shows its stories and their states in both registers; the story swarm's *where to go next* can be answered from the flow |
| **P4 — edit mode** | the gate (policy · tracker · credential), attribution, `confirm` in the HUD, outbox with conflict/re-base, `comment`/`assign`/`transition`/`edit`/`label`/`link` on both providers, MCP write tools registered only when granted, CLI writes, the audit surface | a denied action prints the three verdicts; a stale write is refused and re-based; an agent comment waits for a person; every write is in `audit` with who asked |
| **P5 — later** | `create`; a hosted webhook relay; Jira 3LO + Data Center variant; GitHub Issues / Linear providers; the **file manifest provider** (`work.json` — the Farsight-format sink from the documentation-as-source direction) | — |

P0–P2 are read-only and carry no permission risk; they can ship one at a time. P4 is the only phase that writes to
someone's tracker and is gated by the acceptance above.

---

## 13 · Open questions (decide before P1)

1. **Which Jira site and which Azure DevOps org do we dogfood on?** the reference app's? A Farsight-owned sandbox? P1/P2
   acceptance needs a real instance; the fixture provider covers P0 and CI.
2. **Where the tracker user comes from.** v1 is per-user credentials (every write is *as that user*). Is a shared
   service identity ever wanted — and if so, does attribution (§7.4) suffice, or must the tool refuse writes it cannot
   attribute to a person?
3. **`Resolved` in ADO** maps to `in-progress` with the name kept. Acceptable, or does `StateCategory` need a fifth
   value now (the closed-set rule says: only if a reader cannot otherwise tell — the printed `state.name` says
   *Resolved*)?
4. **ADF converter scope.** Paragraphs, headings, lists, code, links, mentions — and tables? Media (attachments) are
   references only, never bytes in the cache.
5. **Retention.** `item_rev` intervals per source: keep everything (like `farsight.db`) or a window? `audit` is never
   pruned.
6. **Keychain access from Node** without a native module (`security` CLI on macOS, `secret-tool` on Linux, DPAPI via
   PowerShell on Windows) — or `env:` only for v1?
7. **The `@work` tag and `screens.json → work[]`**: which spelling do teams already use in commit subjects
   (`ACME-123:` vs `[ACME-123]` vs `#4711`)? The detector needs both trackers' key shapes.
