# The Settings page: every setting, the source overlay, and custom nodes from the GUI

*Proposal — 2026-10-29. Status: draft, not started. Companion to
[custom-node-patterns.md](custom-node-patterns.md) (the parser side). Owner direction: a clean way to configure most
of what Farsight has today, plus the custom gates, endpoints, patterns, hand-made nodes and OpenAPI registration, from
the tool; Sol implements, Opus reviews against the plan, the lead integrates. Clean architecture, concise, safe.*

## 1. Today

`#/settings` is one long page drawn by `shell.js renderSettings()` (shell.js is 1,800+ lines and owns it): a sources
table (enabled · name · type · path · exclude globs · status · remove, a Sentinel door on local sources) with an
add-source row, collections (name only; members are everything in scope), theme · default register · landing surface,
one experiment (`designShots`), Save and Sync with their consequence sentences, the read-only **Config files** list
(`surfaces/settings-config.js` over `GET /api/config`) and the **Lessons** editor (`surfaces/settings-lessons.js`).
Work sources are edited nowhere in the GUI (provider, site, scope, mode, auth reference, poll, permissions are
hand-written JSON); MCP tier and budget likewise; a source's `storybook` likewise.

What holds: the server writes only `.farsight/settings.json` through `PUT /api/settings` → `settingsProblem()`;
secrets are `keychain:` / `env:` references, never values; every write control carries `[data-write]` and
`lib/read-only.js` greys it on a read-only or `--as-of` server; every string is in the catalog in both registers,
every glyph is `sym()`, every number a `Counted` with a tip; MCP never writes into a source (2026-10-04).

## 2. Information architecture

Settings keeps its address and the top bar, and becomes a sectioned page: a left rail of five sections, each an
address (`#/settings/<section>`, the rail remembers the last one), the content column at most 880 px wide, and a
sticky bottom bar that appears only when something is unsaved (*Save · Discard* with the existing consequence
sentence, then a *sync to apply* door after a save that changes what a sync reads).

| section (code · business) | what is on it | writes |
|---|---|---|
| **Workspace** · *Workspace* | theme · default register · landing surface · experiments (`designShots`) | `theme`, `defaultLens`, `defaultSurface`, `flags` |
| **Sources** · *Systems* | one card per source: name, type, path, enabled, status and last sync, exclude globs, Storybook URL and command, *Sync now*, the Sentinel door, remove. **Add a source** opens a form whose fields follow the type: local · git · openapi · design · work. A work source's form: provider, site or org, scope projects, mode, auth kind + user + **secret reference** (a field that accepts only `keychain:…` / `env:…`, refuses anything else without echoing it), poll, and the permissions editor (a grid of actions × principals, `agentWrites`, `attribution`) | `sources[]` |
| **Collections** · *Collections* | name + a member picker (`lib/multi-pick.js`, the searchable multi-select the code map already uses), reorder, remove | `collections[]` |
| **Source configuration** · *What the code means* | per code source (local · git), two tabs. **In the repository** — the read-only list of its `farsight.config.json` files, fields, conflicts and notes (today's `settings-config.js`). **In this workspace** — the editable overlay (§3): forms for Gates, Endpoints, Patterns, Declared nodes, OpenAPI, Words, Externals and stores; a *JSON* toggle per form; *Export to the repository* shows the merged JSON to paste. Fields the running build does not know are shown greyed with *not in this build* (`GET /api/version` lists `configFields`) | `sources[].config`, `sources[].openapi`, `sources[].openapiIgnore` |
| **Agents** · *Agents* | MCP tool tier and answer budget; the lessons editor (moved here); which sources grant agents which actions, read from the permissions above | `mcp`, `lessons` |

Rules that hold on every section: one model object (`S.SETTINGS`) edited in place, one Save; a field's validation
message is `settingsProblem()`'s own sentence printed beside the field (the server is the one validator — the viewer
calls `POST /api/settings/check` with the draft and prints the answer, so there is never a second rule set in JS);
`[data-write]` on every control; the business register uses the words in the table and hides JSON toggles and copy
doors; the keymap lists `g s` for Settings and `?` works; 1280 px wide works; light theme works; no new dependency.

## 3. The workspace overlay: how the GUI configures a source without writing into it

`.farsight/settings.json → sources[].config` holds a `FarsightConfig` **subset** — the blocks that are data about the
code, not paths into it: `tags`, `glossary`, `guards`, `gateTiers`, `entrypoints`, `setup`, `validators`,
`internalRoutes`, `externals`, `stores`, `lifecycle`, `decisions`, and the new `frameworks`, `patterns`, `nodes`.
`openapi` stays its own field (`sources[].openapi[]`, lane D of the companion proposal) because it is a path.
Path blocks (`design`, `tests`, `storybook`, `plumbing`, `tooling`, `projects`, `journeys`) stay in the repository's
files: they name files, and a file belongs with the repo.

At sync, `ingestRepo(dir, { config: source.config, openapi: source.openapi })` merges the overlay as a **root-scoped
config applied after the repository's root file**: the repository's word wins for the same key and the overlay's is
recorded as a conflict with `from: 'workspace'`; everything else unions exactly as a nested file does
(`shared/config-files.ts mergeConfigs`). `meta.config.files` lists it as `.farsight/settings.json → sources[<id>].config`
so the Config files list, `farsight config list` and MCP `config_files` show it beside the repo's files, and
`declaredPathWarnings` audits it the same way.

Validation is one schema in one place: `settingsProblem()` validates `sources[].config` against
`schemas/farsight-config.schema.json` (the validator `core/test/config-schemas.test.ts` already uses), refusing a
path block, an unknown field, and any value the schema refuses, with the field's path in the message.

**Export to the repository** renders the overlay as the JSON a person pastes into `farsight.config.json`; the CLI's
`farsight config export <source> [--into-source]` writes it for a person who asks. The server never writes a byte
outside `.farsight/`.

## 4. The forms for custom nodes

| form | rows | what one row edits |
|---|---|---|
| **Gates** | a policy annotation or decorator is a gate; a middleware name is a gate; a route carries a declared gate; a gate's tier | `frameworks.spring.security[name]` · `frameworks.nest.guards[name]` · `frameworks.express.middleware[name]` · `guards[label]` (route-shaped) · `gateTiers[matcher]`; fields: name · label template (`$action on $resource`) · tier · grant (`$action`) · a preview of the label filled from a sample |
| **Endpoints** | an annotation or decorator is a mapping; implemented interfaces are delegates; a route by hand | `frameworks.spring.mappings[name]` (method: fixed · `arg:n` · `pair:k`; path likewise) · `frameworks.nest.verbs[name]` · `frameworks.spring.delegates[]` · `nodes[]` with `kind: route` (name · loc · handler · guards · business sentence) |
| **Patterns** | one rule | `patterns[]`: id · files globs · matcher (call · decorator · annotation · query · regex, each its fields) · emit (kind and its fields) · **Test** runs `GET /api/patterns/test?source=&rule=` and lists matches as `file:line · captures · would emit …`, unresolved handlers first; the rule saves only after a test ran or the person says *save untested* |
| **Declared nodes** | a guard, external, queue or route by hand | `nodes[]` (every kind); the audit notes from the last sync beside each row |
| **OpenAPI** | applied documents · candidates (*Register* · *Dismiss*) · registered documents (name · phase) | `sources[].openapi[]`, `sources[].openapiIgnore[]` |
| **Words** | a glossary entry; a tag rule; an entry point label | `glossary[key]` · `tags[tag]` · `entrypoints[label]` |
| **Externals and stores** | an external system; a store | `externals[]` · `stores[]` |

Each row is one JSON entry and nothing more: the form is a view over the overlay object, the *JSON* toggle shows that
object, and a round trip form → JSON → form is lossless (a unit test per form). Every form has an empty state that
names what the row does in one sentence and, in the code register, the field it writes.

## 5. Architecture of the viewer change

- `shell.js` sheds the settings page: `surfaces/settings.js` (the shell: rail, addresses, unsaved bar, save and
  check), `surfaces/settings-workspace.js`, `settings-sources.js`, `settings-collections.js`, `settings-config.js`
  (grows the overlay tab), `settings-forms.js` (the seven forms over one row-editor primitive), `settings-agents.js`
  (lessons moves in). One module per section; `shell.js` keeps only `mountSettings/unmountSettings` and the address.
- Pure models in `lib/settings-model.js`: the section list, the per-type source form fields, the overlay subset,
  `rowsOf(block)` / `blockOf(rows)` for every form, the dirty check — unit-tested under `node:test` in
  `packages/server/test/`, no DOM.
- One row-editor primitive (`lib/row-editor.js`): a table of rows with add · edit in place · remove · move, keyboard
  reachable, ARIA grid, used by every form; no form draws its own table.
- Strings: `strings-settings.ts` registered like `strings-doors.ts`, both registers, a `define` per control.
- Numbers: `count.unit.rules`, `count.unit.matches`, `count.scope.rule` as `Counted`s on the Test result and the
  OpenAPI lists; `docs/COUNTS.md` rows.
- Server: `Settings` and `Source` types, `settingsProblem` (overlay subset through the schema validator),
  `POST /api/settings/check` (validate without saving; allowed read-only), `GET /api/patterns/test` (dry run over the
  source directory, bounded as the pass is; allowed read-only), `GET /api/version.configFields`,
  `POST | DELETE /api/sources/:id/openapi`, and `sync()` passing `config` and `openapi` into `ingestRepo`.
- e2e: `settings-page.pw.spec.ts` (every section renders, save round-trips the file, a bad secret is refused without
  echo, read-only greys every control), `settings-forms.pw.spec.ts` (a gate row and a pattern row saved, tested,
  exported; the overlay shows in Config files after a sync), both on the two-source fixture server.

## 6. Lanes, order, ownership

| lane | owns | depends on |
|---|---|---|
| **S1 server** | `server/src/index.ts` (types, `settingsProblem`, check route, patterns-test route, openapi routes, sync merge), `parsers/src/index.ts` (`options.config` overlay merge), `shared/config-files.ts` (`from: 'workspace'`), `core` (`CONFIG_OVERLAY_FIELDS`), `.farsight/settings.example.json`, server tests | — ; lands first |
| **D parser** (companion) | `openapi/discover.ts` classification, `meta.openapi`, CLI `api candidates\|register\|dismiss` | S1 for the routes |
| **S2 viewer shell** | `surfaces/settings.js`, `-workspace.js`, `-sources.js`, `-collections.js`, `-agents.js`, `lib/settings-model.js`, `lib/row-editor.js`, `strings-settings.ts`, the first e2e | S1 (check route) |
| **A parser** (companion) | `frameworks` aliases, the delegate join | — |
| **S3 viewer forms** | `settings-forms.js`, the overlay tab in `settings-config.js`, Test, JSON, Export, the second e2e, COUNTS rows | S1, S2; forms for `frameworks` / `patterns` / `nodes` grey until A / B / C land (`configFields`) |
| **B parser** (companion) | `patterns.ts`, `config-pattern`, `patterns test` | — |
| **C parser** (companion) | `nodes[]` | A (config.ts) |

Waves: **1** S1 ∥ D ∥ A → **2** S2 ∥ B → **3** S3 ∥ C. Two lanes never own the same file; where a wave's lanes both
add a `strings-<area>.ts` import to `strings.ts`, the later one merges main first (one known conflict, keep both).

## 7. How the work runs

- **Sol implements** each lane: a bridge session per lane (`agent_bridge start_session {provider: "codex", project:
  "farsight", access: "workspace-write", title: "<lane>"}`), which gives it a worktree and a `codex/bridge-…` branch;
  the brief (template below) names the lane's files, the proposal sections it implements, the checks from
  `docs/CI.md`'s table, and the PR title. Sol opens the PR and reports the PR number, the numbers, and what it left
  open. Corrections go back to the same session (`send_message`).
- **Opus reviews** each PR twice, as subagents of the lead (Agent tool, `model: "opus"`), read-only on a checkout of
  the PR head: the first writes a ranked list in Conventional Comments (plan conformance against the named sections ·
  architecture rules in §2 and §5 · the invariants in `AGENTS.md` · tests · strings and counts); the second, after
  Sol's corrections, verifies each item at file:line and says *may merge* or *not yet*. Neither edits.
- **The lead** checks `gh pr view <n> --json baseRefName` is `main`, lints the title, squash-merges, then the ritual
  (build · tests · `lint:strings` · e2e · pack · reinstall under both prefixes · restart 4477/4478 · re-sync), and the
  next wave starts. Parser lanes carry the real-ingest comparison in their PR body.
- **Done** = all seven lanes merged; a person can, from Settings alone on the dogfood server: add a work source with
  a keychain reference, declare `@SomeAnnotationPolicy` as a gate and see it in `farsight roles`, register a found
  OpenAPI candidate and see its routes after a sync, write a pattern, test it, save it and see its routes on the Map;
  `docs/AI-HANDOFF.md` has the dated entry; nothing was committed on `main` locally; the primary checkout is on
  `main` with a `main` build.

### Sol brief template

```
Lane <id> — <title>. Worktree: this session's. PR title: `<type>(<scope>): <subject>` (lint it with `pnpm lint:commits --message`).
Read: AGENTS.md; docs/proposals/settings-page.md §<n>; docs/proposals/custom-node-patterns.md §<n>; docs/CI.md (the change-to-check table).
You own these files and no others: <list>. Another lane owns <files>; do not touch them.
Build: `pnpm install --frozen-lockfile --ignore-scripts && pnpm build`; checks for your change class: <from the table>; e2e on ports <x/y/z>.
Every string through the catalog in both registers; every number a Counted; every write control [data-write]; no new dependency.
Commit often (conventional subjects, Co-Authored-By trailer); open the PR with the template (what changed · why · how it was checked · left open), the numbers in the body.
Report: the PR number, the checks you ran with their results, what you left open. Do not merge.
```

### Opus review brief template

```
Review PR #<n> (branch <b>) against docs/proposals/settings-page.md §<n> and §5, docs/proposals/custom-node-patterns.md §<n>, and AGENTS.md's invariants.
Check out the PR head read-only in a worktree of your own; run the checks its change class needs (docs/CI.md). Never edit, never push.
Report in Conventional Comments, ranked, each with file:line: (1) plan conformance — anything the sections require that is missing or different; (2) architecture — one module per section, pure models tested without the DOM, one validator (the server), no second rule set in JS, no new dependency; (3) safety — secrets as references only, nothing echoed, [data-write] on every control, read-only refused server-side; (4) quality — tests for every form's round trip, strings in both registers, Counted on every number, no dead code moved rather than deleted.
End with: may merge / not yet, and why in one sentence.
```

## 8. Kickoff prompt for the lead session

The prompt a new session starts from is kept with this proposal so it survives this session:

```
You are Fable, the lead session on Farsight. Read AGENTS.md, then the top of docs/AI-HANDOFF.md, then
docs/proposals/settings-page.md and docs/proposals/custom-node-patterns.md in full. Those two proposals are the plan;
§6–§8 of settings-page.md say how the work runs. Do not re-derive the design.

First: `git status --short --branch` in the primary checkout (stay on main there; build nothing there). If the two
proposals are untracked, a worktree under ../farsight-wt/ gets them as one PR, `docs(proposals): settings page and
custom node patterns`, and you merge it after CI (docs-only: no runtime checks).

Then run the waves exactly as §6 orders them: wave 1 = S1 ∥ D ∥ A, wave 2 = S2 ∥ B, wave 3 = S3 ∥ C. One Sol session
per lane over agent_bridge (provider codex, project farsight, access workspace-write), briefed with §7's Sol template
filled in; wait_for_reply; corrections to the same session. Two Opus reviews per PR with §7's review template, the
second after corrections; merge only on "may merge". Check the PR base is main, lint the title, `gh pr merge --squash`,
then the ritual in ~/.claude/projects/-Users-jaredkremer-development-farsight/memory/dispatching-agents-farsight.md.
Parser lanes (D, A, B, C) carry the real-ingest comparison against a main build in their PR body.

Hold the lines: nothing committed on main locally; no `git stash`; servers stopped by port; secrets never in files;
the server writes only .farsight/; MCP never writes into a source; every string in both registers; every number a
Counted; no new dependency without saying so to Jared first.

Report to Jared at the end of each wave in five lines: PRs merged, numbers, what a reviewer blocked, what is left,
what you need from him. When all seven lanes are merged, run §7's "done" walk on the dogfood server yourself, write
the dated entry at the top of docs/AI-HANDOFF.md, and stop.
```
