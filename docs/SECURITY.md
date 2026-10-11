# Security

Farsight is a local developer tool. It reads code on your machine. It serves what it found to you, to your
agents and to your shell. With your own credential, it reads and writes the trackers you configure. This page
covers what it trusts, what it refuses, and how to report a problem.

## Threat model

| part | who can reach it | what guards it |
|---|---|---|
| **viewer server** (`farsight serve`, default :4477) | processes on this machine; web pages open in your browser | binds `127.0.0.1` only. Answers loopback `Host` names only (`localhost`, `127.0.0.1`, `[::1]`), so a DNS-rebinding page gets 403. Refuses a `POST`/`PUT` whose `Origin` or `Sec-Fetch-Site` names another origin, so another site cannot start a sync, rewrite settings or queue a tracker write. Never sends CORS headers, so another origin cannot read a response. (`packages/server/src/guard.ts`) |
| **MCP server** (`farsight mcp`) | the client that spawned it, over stdio | no network listener. Its tracker writes are stamped `requestedBy.kind: 'agent'` and go through the same gate as the viewer's. Of `.farsight/settings.json` it reads `sources` (for work and code-host sources) and, for the session-start context (`farsight://context`, `graph_overview brief:true`), **only** `mcp.tools`, `mcp.budget` and `lessons` (`packages/mcp/src/context.ts readAgentSettings` drops every other field unread), so a source, its `auth` block or a keychain reference never reaches an agent through the context — `test/mcp-agents.test.ts` asserts it. Lessons are written by a person on the Settings page; no tool writes them, and `PUT /api/settings` refuses a lesson shaped like a credential (a keychain or env reference, a bearer/basic header, a long unbroken token) without echoing it. The core tool tier (the default) is read-only. |
| **CLI** | you | — |
| **secrets** | this process only | settings hold a *reference* (`keychain:farsight/<provider>-<instance>`, or `env:NAME` for tests and CI), never a value. `packages/work/src/secrets.ts` resolves it in process with `security` (macOS) or `secret-tool` (Linux). `PUT /api/settings` refuses an `auth.secret` that is not a reference, without echoing what was sent. Errors name the reference, never the value. The Jira client scrubs the token and the encoded header from any error text it keeps. Only response bodies are recorded as fixtures or stored as an item's `raw`; request headers never are. |
| **trackers** (Jira, Azure DevOps) | reached with your credential | a write needs three verdicts: the workspace policy (`permissions`), the tracker's own answer for this item and action, and a usable credential. A source is `read-only` unless its settings say `edit`. |
| **code hosts** (GitHub) | reached with your credential: `keychain:farsight/github-<org>` on a `type: 'code-host'` source, read in process; the GitHub CLI's own login **only** when you pass `--via gh` | `farsight affected --post` writes one comment (found again by its marker line and edited in place) and one commit status, through the same three verdicts as a tracker write (the source's `allow.people` / `allow.agents` and `mode: 'edit'` — default deny · the host says the pull request is open and the credential may push · the credential is accepted) and `--confirm`. MCP `affected` reads only, and is registered only when a source grants agents `read`. Azure DevOps posting is refused with words (not built). |
| **Echo settings** (`farsight-echo serve`, workspace defaults :4480/:4481; global defaults :4490/:4491) | processes on this machine; the local settings page | binds `127.0.0.1`. Checks the exact loopback `Host` and port, `Origin`, and `Sec-Fetch-Site`; settings writes require JSON, a body no larger than 64 KB, and the current `If-Match` revision. Cross-process locking prevents a stale browser or CLI update from silently overwriting another edit. No CORS headers; CSP permits embedding only by the explicitly configured local Farsight origin. A permitted frame can navigate to the HTML shell, but data requests still require the Echo origin. Responses contain credential references, never resolved values. (`echo/src/web.ts`, `settings-lock.ts`) |
| **Echo managed backend** (agentmemory + iii) | processes on this machine, through four loopback ports per running profile | with configured REST port `p`, Echo reserves `p` (REST), `p+1` (stream), `p+2` (agentmemory viewer), and `p+46023` (engine worker connection), then refuses any occupied port. REST calls use a fresh random Bearer secret per run, retained in process and the deliberately restricted child environment. The upstream viewer proxies to REST with that secret; these loopback services are not a per-user or team-authentication boundary. Echo owns two foreground child processes and stops only those processes. (`echo/src/runtime.ts`) |
| **Echo memory bridge** | the current OS user through `/tmp/farsight-echo-<uid>/<profile-hash>.sock` | requires an owner-held 0700 directory and 0600 Unix socket, refuses foreign or symbolic replacements, and checks inode identity before removing a stale socket. Requests and replies have size limits and deadlines. Each request must match the running configuration, profile and identity fingerprint; backend secrets remain in the service. (`echo/src/memory.ts`) |
| **Echo configuration, hooks and runtime** | the user who explicitly sets up Echo and grants host hook trust | user-state receipts bind the exact configuration and workspace connection bytes to their canonical paths. Repository-supplied settings or edited pointers cannot grant themselves trust. Runtime downloads and execution follow the checksum rules below; a workspace cannot supply the engine executable. Hooks are local opt-in files, protected from ordinary Git staging, and host trust remains separate. (`echo/src/trust.ts`, `installation.ts`, `workspace-hooks.ts`, `runtime.ts`) |

The server trusts any process that runs as you. That process can already read your files and run `git`, so
it is inside the boundary. The guard draws the line at other web origins, not at other local programs.

**`requestedBy` over HTTP is a claim, not an identity.** The viewer's write routes take the principal from
the request body (`human` unless it says `agent`), so a local program can say it is a person. Inside the
boundary above, this is by design: the policy's `human`/`agent` grants guard against mistakes, not against a
hostile local process. An agent that should not write as a person must reach trackers only through MCP.

## Echo's separate local boundary

Echo is optional and has its own package, settings, store and processes. Farsight does not start it or depend on
its runtime. Each workspace selects one Echo configuration and one profile; choosing the same global profile
in two workspaces shares that store deliberately. Profiles keep separate stores and identity namespaces, and
a host session cannot switch identity or store mid-chat. These controls prevent accidental mixing; team
authentication and permission enforcement are not built. Keep managed ports local rather than publishing them
as a shared team service.

**A checkout cannot approve its own configuration.** Echo records configuration, connection and credential-origin
receipts under `${XDG_STATE_HOME:-~/.local/state}/farsight-echo/`, outside the workspace. The directories are
owner-only (0700) and receipts are owner-only regular files (0600), with symbolic links refused. A configuration
receipt binds its canonical path and exact contents; a connection receipt similarly binds the workspace's
selected configuration and profile. Echo creates or refreshes these receipts when it writes settings or connects
a workspace. A file copied from another machine or edited outside Echo is untrusted until explicitly reviewed
and adopted; `doctor`, model discovery and normal startup do not silently approve it. Use Echo's settings view
for edits, or review the complete file before the explicit `trust --confirm` command. Reconnect a workspace
through Echo instead of hand-editing its pointer.

**Credentials have an Echo-only namespace and one origin.** Echo accepts only
`keychain:farsight-echo/<account>` references. It cannot resolve a Farsight tracker credential or an inherited
environment secret. Saving or explicitly adopting settings pins each reference to its exact origin (scheme,
host and port) in user state; resolution checks that pin before reading the OS keychain. Reusing a reference
for a different origin is refused, so use a separate Echo account for a different endpoint. Endpoints outside
loopback require HTTPS, and authenticated requests refuse redirects. Echo and Work share the OS keychain
transport in `packages/core/src/keychain.ts`; their reference and authorization policies stay separate. The model adapter bounds
input, output and elapsed time. Live hooks currently retrieve bounded saved excerpts; they do not call a model
or automatically capture conversation content.

**Only the explicitly installed engine runs.** `install-runtime` fetches a pinned iii release from GitHub and
compares the complete archive with its compiled-in SHA-256 before extraction. It stores the executable under
`~/.cache/farsight-echo/runtime/<version>/<platform>/`, never under a checkout's `.echo/` directory. The cache
and files must belong to the current user, with private permissions and no symbolic replacements. Installation
records the extracted executable's SHA-256; every version probe and engine launch verifies it again before
execution. There is no implicit download during `serve` and no engine install from an npm lifecycle script.
An invalid hash refuses execution rather than trying to repair or run the file.

Managed startup refuses an existing `~/.agentmemory/.env`: the pinned backend can read that global file, so
allowing it would bypass profile separation. Echo supplies a restricted child environment instead of inheriting
process credentials, proxy settings or another model's settings. It disables the agent SDK, automatic capture,
compression, consolidation, automatic forgetting, lesson/insight decay, snapshots, the Claude memory bridge
and OpenTelemetry. The profile owner lock is recovered only for a confirmed dead process; a live or malformed
lock is not removed. External mode requires an independently secured compatible backend and remains read-only
through Echo because the pinned upstream write path can supersede legacy records outside Echo's namespace.

**Local hooks stay local and can be removed.** Installation appends workspace-relative rules to Git's local
`info/exclude`: `.echo/*` with the two example twins exempted, and exact paths for Claude, Codex and VS Code
hook files. It preserves shared ignore files and refuses tracked destinations or a higher-priority rule that
leaves a generated file trackable. The repository itself ignores `.codex/hooks.json` and `.github/hooks/echo.json`
as well. Host trust is still required; installing files never grants it. Only `SessionStart` and
`UserPromptSubmit` are registered. `disconnect` removes marker-owned commands and restores the original bytes
when the installed file is unchanged. If other edits were made, it preserves those edits and removes only Echo
commands. Restoration records live in the private user-state `hooks/` directory; ignore rules remain in place.

**Memories are historical, untrusted reference data.** Explicit saves reject the same credential-shaped content
as pinned lessons, without echoing it back. Each new memory has an independently recorded workspace, HEAD
commit when available, and save time bound to its exact content. Hook output labels that provenance and says
the memory was not read from the code; older or changed records have unknown provenance. Records are encoded
as JSON strings, bounded by the configured brief budget, and accompanied by an omission notice when truncated.
The current checkout remains the source of truth. These checks reduce accidental credential capture and prompt
confusion; they do not make arbitrary saved prose authoritative.

## Workspace reads and rendering

**What the server will fetch or run on its own:** `git clone` / `git pull` for `type: 'git'` sources, and
`git log` / `git show` on configured checkouts (commit ids are checked as hex, and a clone URL is passed after
`--`). It probes the Storybook URLs the graph recorded. It fetches spec or manifest URLs that a source or a
diff request names, and Figma renders when `FIGMA_TOKEN` is set. `POST /api/sync` re-ingests every enabled
source and costs CPU. Any local process may trigger it, and nothing beyond that is at stake. NX's project-graph
file (`.nx/workspace-data/project-graph.json`, an older cache path, or the one `projects.graphFile` names) is read,
never produced: Farsight does not run `nx`, the file must resolve inside the source and stay under 20 MB, and only
names discovery already found count. A `farsight.config.json` in a folder below the source root names paths
relative to its folder; one that is absolute or climbs out of the source with `..` is dropped with a note, so a
nested config file never points ingest outside the source (its URLs are fetched like the root file's).

**The viewer renders text it did not write.** That includes code identifiers, file paths and JSDoc from any repo
you ingest, tracker titles and comments, Storybook titles, and spec prose. Every value goes into HTML through
`esc()` (`public/app/store.js`). A value used as an argument inside an event-handler attribute goes through
`jsArg()`, because the HTML parser decodes `esc`'s `&#39;` before the handler runs. A link built from data must
be `http(s)`, `vscode://` or an in-app `#/` route. Azure DevOps HTML bodies are reduced to text before they reach
the viewer. The viewer's CSP limits frames, plugins and `<base>`. It does not yet forbid inline scripts, because
the viewer uses inline handlers.

## What Farsight never does

- **No telemetry.** It sends nothing to its authors or to any service you did not configure.
- **Never reads or prints a session link.** A commit's `Co-Authored-By` trailer names the AI assistant it was made
  with, and that name is all the commit spine keeps (*made with an agent · <name>*). A `Claude-Session:` or any other
  URL trailer is never read: which session made which commit is the owner's private record.
- **Never prints a secret.** It does not log one, put one in an error message, write one to `graph.json`,
  `work.db`, a fixture or the settings file, or serve one over HTTP.
- **Never writes to a tracker without the three verdicts** (policy, tracker, credential). A dry run
  (`dryRun: true`) writes nothing to the tracker.
- **Never starts, installs or builds** a Storybook or anything else it finds in your repo. A Storybook
  `command` in settings is shown to you, not run.
- **Never sends a saved view anywhere.** *Save* (a picture, a PDF or the Portfolio's CSV) is drawn in your
  browser from the page you are looking at and handed to the browser to save; there is no export route on the
  server, and the file leaves the machine only if you send it. Its footer names the source, the sync, the source
  commit and the day — check that before sharing a picture outside your team.

## Reporting a vulnerability

Report it privately via GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
[the repository](https://github.com/zalos/farsight/security). Do not open a public issue for it. The
repository owner must enable the feature in **Settings → Security → Private vulnerability reporting**.

## The scan in CI

Every push to `main` and every pull request runs the `secrets` job in `.github/workflows/ci.yml`:
[gitleaks](https://github.com/gitleaks/gitleaks) (`gitleaks/gitleaks-action@v3`, gitleaks 8.30.1) over the
commits, with the default rules plus `.gitleaks.toml`. The allowlist there is by line, for two recorded Jira
fixture shapes that look like keys and are not (search cursors, the session-bound XSRF token). Run the same
scan locally before pushing fixtures:

```sh
gitleaks dir .     # the working tree
gitleaks git .     # every commit
```

Fixtures recorded from a live tracker must be rewritten to the example values before they are committed:
`example.atlassian.net`, `dev.azure.com/example-org`, `dev@example.com`, and placeholder ids
`00000000-0000-4000-8000-…`. `pnpm audit --prod` should report nothing. Refresh the lockfile when it does.
