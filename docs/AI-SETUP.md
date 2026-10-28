# AI session setup — runtime, provider access, live trackers

Durable setup notes for Codex and Claude sessions, moved out of the session-start handoff on 2026-10-28.
Read when setting up a machine, a provider or a live tracker check; `AGENTS.md` holds the rules.

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
- Both provider configurations have eight corresponding review personas and three outsider personas (a comprehension round on the application Farsight displays) under their respective `agents/` directories (how to run them: `docs/review-swarm.md`).
- After rebuilding, restart running viewer/MCP processes before trusting new behavior. Reload the browser after refreshing the graph.
- Use `node packages/cli/dist/cli.js status` to inspect build/graph/server currency. Do not assume a successful build updated an existing server.
- Preserve the multi-source dogfood graph: use the workspace server's `POST /api/sync` after restart. Bare CLI ingest replaces it and ignores workspace source excludes. Smoke-test ingest from a temporary cwd with an explicit output path instead; SQLite history is cwd-relative too.

Codex project instruction and MCP conventions were checked against [official AGENTS.md documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Live tracker tests

**Live tracker tests** run only with `FARSIGHT_LIVE=1` and read their target from the environment:
`FARSIGHT_JIRA_SITE` / `FARSIGHT_JIRA_USER` / `FARSIGHT_JIRA_KEYCHAIN` and `FARSIGHT_ADO_ORG` /
`FARSIGHT_ADO_PROJECT` / `FARSIGHT_ADO_KEYCHAIN`. The defaults are the example values above, so without the env they
skip with a reason. The Jira test writes one comment and one label on the test site; the ADO test only runs
`validateOnly` dry runs. The recorded fixtures under `packages/work-jira/test/fixtures/` and
`packages/work-azdo/test/fixtures/example-org/` were recorded live and then re-synthesized with placeholder names,
ids, titles and bodies; the shapes are as recorded. A re-recording must be scrubbed the same way before it is committed.

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
