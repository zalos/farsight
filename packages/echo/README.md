# Farsight Echo

Echo is an optional, independently running memory companion for Farsight. It has its own package, settings, model connection, and memory stores. The regular Farsight CLI does not need Echo or agentmemory.

**This iteration supports explicit memory storage and scoped recall.** With `serve` running, you can save a memory, retrieve it from the CLI, and let supported host hooks add a small amount of relevant memory context to a new prompt. It also provides the settings view, isolated profiles, runtime verification, and a model summary check. Automatic conversation capture and a model-driven memory agent are still to come.

## Prerequisites

- **Node 24 or newer.** Source development also requires **pnpm 9.0.0**.
- **macOS or Linux, arm64 or x64**, for the managed memory runtime. The local memory bridge, hooks, and credential-store integration target macOS/Linux in this iteration. An external backend can be hosted elsewhere.
- **Ollama running with a local text model**, for the model test. Use an existing model shown by `ollama list`. Echo does not install Ollama or silently download a model. See [Ollama setup](https://docs.ollama.com/quickstart) if needed.
- Network access for initial package and engine downloads. The local memory and Ollama path does not require a hosted model API key.

The package pins `@agentmemory/agentmemory` to **0.9.30** and the iii engine to **0.22.1**. Echo verifies the downloaded engine against its pinned checksum.

## Quick start from this repository

Run these commands from the repository root using Node 24:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/echo/dist/cli.js setup
```

For a first test, choose an installed Ollama model, answer **no** to both hook questions, and **yes** to installing the managed runtime. Hook preparation can be tested separately later.

Setup creates `.echo/settings.json` with `personal` and `work` profiles. Both begin with hooks disabled and separate memory addresses. Setup configures the selected profile; the default is `personal`. It does not start a server.

Check the configuration, exercise the backend and model, then start the settings view:

```sh
node packages/echo/dist/cli.js doctor
node packages/echo/dist/cli.js smoke --with-model
node packages/echo/dist/cli.js serve
```

Open the URL printed by `serve`: with the default personal profile it is [http://127.0.0.1:4480](http://127.0.0.1:4480). Leave this terminal running. Ctrl-C shuts down Echo's settings server and its owned memory processes.

If you declined engine installation during setup, run `node packages/echo/dist/cli.js install-runtime` before the smoke test. To test storage without a model, run `smoke` without `--with-model`; the model check in `doctor` will still report an unconfigured or unavailable model.

You can also run `smoke` in a second terminal while `serve` is running. It chooses separate available ports and disposable stores; it does not test against or write into the running profile's store.

## Install the standalone package

You can test Echo without running the rest of the Farsight workspace. From a built checkout:

```sh
pnpm pack:echo
```

This writes an installable tarball under `build/echo/` and prints its exact filename. Install that file with npm; replace `VERSION` below with the version in the filename:

```sh
npm install --global ./build/echo/farsight-echo-VERSION.tgz
farsight-echo --help
```

This builds and installs a local artifact; it does not publish to npm. The standalone package includes the settings view and pinned agentmemory dependency. Engine installation remains an explicit setup step.

Change to the folder where you want to keep Echo's local state, then run:

```sh
farsight-echo setup
farsight-echo doctor
farsight-echo smoke --with-model
farsight-echo serve
```

The rest of this guide uses `farsight-echo`. When working from source, substitute `node packages/echo/dist/cli.js` while in the repository root.

## Test the current iteration

| Test | What to do | What a successful result means |
|---|---|---|
| Configuration | Run `doctor` | The pinned package, managed engine, isolation precondition, and chosen Ollama model are available. Managed `doctor` does not start the backend. |
| Memory storage | Run `smoke` | `remember-recall`, `restart-persistence`, and `store-isolation` each report `ok: true`. |
| Persistent memory | Keep `serve` running, then use `remember` and `recall` as shown below | The explicitly saved fact is returned from the selected managed profile and survives restart. |
| Model connection | Run `smoke --with-model` | The same storage checks pass, plus `model-summary` returns a short summary of synthetic shipping text. |
| Settings view | Run `serve`, open its URL, and refresh the checks | The settings page loads and the running backend reports readiness. The view remains available if the backend needs attention. |
| Save/reload | Change a harmless setting, save, and reload the page | The saved value persists. Restart `serve` to apply runtime changes. |
| Profile editing | Select `work` in the settings view | You can edit work's settings; the running profile indicator remains on the profile started by `serve`. Selecting an editor tab does not switch services. |

Smoke uses disposable stores and synthetic text. It never writes into your personal/work memory store or an external backend. It stops its own processes and removes successful test data. A failed test prints a temporary diagnostics location and retains its synthetic logs.

The optional model check summarizes the synthetic sample directly after the storage assertions. It verifies the model connection independently; it is not an agentic retrieve-and-summarize workflow.

The web view currently manages configuration and connection checks. Use the CLI and host verification below to inspect memory access; the web view is not a memory browser or a capture history view.

## Save and recall a memory

Keep `serve` running for the selected **managed** profile. In another terminal, use the same configuration and profile. This example deliberately saves a synthetic test fact to your selected profile's persistent store:

```sh
farsight-echo remember --profile personal --topic echo-test --content "The synthetic echocoldtest shipment uses a blue insulated test container."
farsight-echo recall --profile personal --query "echocoldtest" --limit 3
```

`remember` returns the stored `id` and `createdAt`. `recall` returns a `memories` list with each record's `id`, `title`, `content`, and `timestamp`, plus a `truncated` indicator. The list should contain the test fact. Stop and restart `serve`, then repeat `recall` to check that it persists. Unlike `smoke`, `remember` writes a real memory to the selected store; it is not a disposable test operation.

Repeat `--topic` to attach more than one topic. Topics and timestamps are stored metadata; day/topic browsing and rollups are not implemented. Recall returns at most five records, with combined title/content bounded by the profile's brief-character limit. `--limit` can request fewer records; it cannot bypass that ceiling.

You can ask a host agent to invoke these commands after the hook has supplied the access instructions. Storing a memory is an explicit action. Echo does not import old chats or silently save each prompt, tool result, or response.

Commands and hooks connect to the running Echo process through a local filesystem-protected Unix socket. The settings website does not expose a public memory read/write API. If Echo is stopped or its selected configuration has changed since startup, restart `serve` before using memory commands.

**Explicit saves currently require managed mode.** External mode supports scoped recall only. Echo refuses external writes because the pinned backend's memory supersession can affect older unscoped records. External recall accepts only records already in the exact Echo namespace and individual scope; it does not import legacy unscoped memories.

## Configuration and profiles

By default, commands use `.echo/settings.json` relative to the current directory. Use `--config` to consistently select another file and `--profile` to override `defaultProfile`:

```sh
farsight-echo setup --profile work
farsight-echo doctor --profile work
farsight-echo serve --profile work
farsight-echo serve --config /absolute/path/to/echo/settings.json --profile personal
```

Run each `serve` in its own terminal; never start two writers for the same store. Personal and work have separate defaults: web ports **4480** and **4481**, and backend base ports **4611** and **4711**. Each managed backend also reserves its base port plus 1, plus 2, and plus 46023. The configuration validator rejects overlaps across profiles and local model/web ports.

For noninteractive initialization, replace `MODEL_NAME` with the exact installed model name:

```sh
farsight-echo init --model MODEL_NAME
farsight-echo install-runtime
```

`init` refuses to overwrite an existing file. For an existing profile, use `setup --model MODEL_NAME`, edit it in the settings view, or edit the local JSON. `setup` requires an interactive terminal and asks about hooks and runtime installation.

| Setting | How to use it |
|---|---|
| Identity | Set an individual, project, and optional team. These are routing labels, not authenticated team membership. |
| Memory connection | Choose `managed` for Echo-owned local processes or `external` for your own agentmemory instance. |
| Model | Select `ollama`, an origin such as `http://127.0.0.1:11434`, and an installed model name. An `openai-compatible` adapter is also available. |
| Limits | Set the request timeout, generated-token limit, and final summary-character limit. An incomplete model response fails the check. |
| Hooks | Record which host may bind sessions and use prompt recall. These switches do not install hook definitions into a host. |
| Skill directories | Save explicit future discovery locations. Echo does not yet read, install, or execute these skills. |
| Farsight address for embedding | Optionally allow an exact local Farsight origin to frame the view. Farsight navigation integration is not built yet. |

Use service origins without paths or credentials in URLs. The compatible adapter adds `/v1/chat/completions` itself; do not put `/v1` in the configured origin. Remote endpoints must use HTTPS. Ollama has been checked with a real local model; other compatible providers require their own validation. `doctor` checks only the model selection for compatible endpoints; the managed `smoke --with-model` path exercises an actual call.

Personal and work have separate local stores. Within one configuration directory, a host session is bound to its chosen profile, identity, backend, and model settings. Start a **new host session** when changing those boundaries. Keep personal and work in the same configuration file so their session bindings are checked against the same registry. This is local isolation, not multi-user team authorization.

## Managed or external memory

Managed mode starts the pinned agentmemory worker and iii engine with a deliberately restricted environment. Credentials are generated in memory for that run; leave the managed backend credential reference empty. Echo owns their lifecycle and will not adopt a process already listening on the configured ports.

For an external instance, edit the selected profile in the settings view:

1. Set memory mode to `external` and enter the instance's service origin.
2. If it requires a credential, store it in macOS Keychain or Linux Secret Service and enter only a reference such as `keychain:farsight/echo-example`.
3. Save, restart Echo, and run `doctor --profile NAME` to check the backend identity and supported version.

External mode expects agentmemory **0.9.30**. It does not install, start, or stop that service. Give personal and work different instances; project filters alone do not establish tenant security. `smoke` intentionally requires managed mode so it cannot insert test records into an external store.

The external connection is read-only through Echo's memory bridge in this iteration. `remember` is refused; `recall` still applies the selected Echo namespace and individual filter.

Echo resolves `keychain:<service>/<account>` locally. In the example, the service is `farsight` and the account is `echo-example`. Do not put secret values into settings, URLs, command arguments, or committed files. Keychain integration currently supports macOS and Linux.

## Connect a workspace to its agents

Package installation never prompts or modifies your agent's settings. To explicitly install workspace hook definitions for all supported hosts, run:

```sh
farsight-echo hooks --host all --install --workspace /absolute/path/to/workspace --profile personal
```

Add `--config /absolute/path/to/echo/settings.json` if your settings are not in the current directory's `.echo` folder. The installer preserves unrelated hooks/settings, backs up changed files under the configuration directory's `backups/` folder, and can be run again to update its own definitions. It refuses malformed existing settings before writing. Installing definitions does not bypass host trust or install editor extensions.

The generated definitions contain this machine's absolute Echo/configuration paths. Keep them local and untracked; they are not portable team configuration.

| Host | Workspace configuration | What to do after installation |
|---|---|---|
| Claude Code CLI and Claude Code's VS Code extension | `.claude/settings.local.json` | Open that workspace and start a fresh Claude session. Review the host's hook settings and permissions. |
| Codex CLI and the Codex VS Code extension | `.codex/hooks.json` | Ensure hooks are enabled, trust the project, and review the exact hook definitions. Start `codex -C /absolute/path/to/workspace`, use `/hooks` for inspection and trust, then start a new session in the intended host. |
| VS Code Local chat | `.github/hooks/echo.json` | Use a trusted workspace and a Local chat session with `chat.useHooks` enabled. This does not target Copilot Agent Host sessions. |

Do not enable the same Echo hook through both a plugin and workspace settings. For VS Code Local chat, avoid loading the Echo hooks again through `chat.useClaudeHooks` when the dedicated `.github/hooks/echo.json` is installed. The installer refuses an installation that would create that duplicate path; it does not rewrite editor preferences to bypass the conflict. Use `--host claude`, `--host codex`, or `--host vscode` with `--install` to select one workspace integration.

To prepare a reviewable plugin without installing workspace definitions, the earlier commands remain available:

```sh
farsight-echo hooks --host claude --profile personal
farsight-echo hooks --host codex --profile personal
```

They write `.echo/plugins/<profile>/<host>/` and print manual loading instructions. Without `--install`, `--host all` prepares all three hosts' files instead of changing workspace settings. Claude can load the plugin with `claude --plugin-dir <generated-directory>`. Codex uses the generated local marketplace, then separate installation and hook trust. Prefer one integration route per host.

The lifecycle points are `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, and `Stop`:

- `SessionStart` binds the session and supplies brief instructions for memory access.
- `UserPromptSubmit` searches the selected memory scope and adds bounded relevant context to the request.
- The remaining events maintain the session boundary; they do not capture conversation content.

The hook lookup does not call the configured model. It provides bounded search results rather than an autonomous agent-generated summary. The total injected text, including instructions and record metadata, stays within the profile's brief-character limit. If Echo is unavailable, hooks let the host continue without memory context. Explicit `remember` with a managed profile is the way to store a memory in this iteration.

Enable one Echo profile per host session. Disabling its hook preference stops Echo processing future callbacks; disable the host definition or plugin to stop launching the runner. Reinstall or reprepare hooks after moving Echo or its configuration because generated runners use absolute paths.

### Verify memory in a fresh chat

1. Start `serve`, save the `echocoldtest` fact above, and confirm that CLI `recall` returns it.
2. Install hooks for the intended workspace, complete the host's trust steps, and open a **new** chat in that workspace.
3. Ask: **“What does Echo remember about echocoldtest? Use only the stored memory.”** The relevant result is the blue insulated test container.
4. If needed, ask the agent to run Echo's printed recall command explicitly. This separates a working memory connection from a host that has not loaded its hooks.

A session binding file under `.echo/sessions/` only demonstrates that a callback reached Echo. It does not prove prompt recall worked. Verify the stored fact in the actual host response or its hook diagnostics; synthetic runner tests do not establish that an editor extension loaded the definitions.

For VS Code Local, **Chat: Configure Hooks** shows discovered files, and the **GitHub Copilot Chat Hooks** output channel reports callback output/errors. Those Local controls do not configure the Claude or Codex extension's hooks.

## Stop, restart, and local files

Stop `serve` with **Ctrl-C** and wait for it to exit. It closes the settings view and only the backend processes it started. Externally managed services stay running. Start the same command again to apply saved runtime settings. A normal restart preserves the selected profile's store.

With the default configuration, Echo keeps its persistent settings and state in:

```text
.echo/
  settings.json          Local configuration
  runtime/               Downloaded, pinned engine
  profiles/personal/     Personal store, runtime config, and logs
  profiles/work/         Work store, runtime config, and logs
  sessions/              Session binding metadata
  plugins/               Prepared host plugins
  backups/               Previous settings from workspace hook installs
```

Agentmemory uses iii's file-backed state store. These live files are not a Git collaboration format. Keep `.echo` runtime state ignored; commit only scrubbed examples such as this repository's `.echo/settings.example.json`. Moving a configuration file also changes where its adjacent runtime state is located.

## Troubleshooting

| Symptom | Next step |
|---|---|
| Model unavailable or no models listed | Confirm Ollama is running and check `ollama list`. Select that exact name. If necessary, explicitly download your chosen model with `ollama pull MODEL_NAME`, then rerun setup. |
| Model stops before completing its brief | Increase the generation limit or choose a suitable local model. For a slow first load, increase the timeout. Echo refuses incomplete output. |
| Engine missing or checksum mismatch | Run `install-runtime` to download and verify the pinned engine again. |
| Managed mode refuses global agentmemory configuration | The published worker reads `~/.agentmemory/.env` globally. Use a deliberately isolated external instance if you need that existing installation. Do not delete another tool's settings to bypass the check. |
| Port already in use | Stop your own existing Echo instance or select non-overlapping ports. Do not kill unrelated servers. |
| Profile locked after a crash or forced kill | Inspect `.echo/profiles/<profile>/echo-owner.json` and its PID. Confirm that process and all owned backend children are stopped and its ports are free before removing only that stale lock. Preserve the store. |
| Saved setting is not active | Restart `serve`. Editing another profile or changing the default does not switch an already running process or host session. |
| Settings changed elsewhere | Reload the view, review the new values, and reapply your changes. Conflicting edits are refused rather than silently overwritten. |
| Recall cannot reach Echo | Start `serve` with the same configuration and profile. After changing identity, backend, or model settings, restart it and use a fresh host session. |
| No memories appear in the main agent | First confirm CLI `recall` finds an explicitly saved memory. Then check the intended workspace, host support, hook preference, exact-definition trust, and a fresh chat. Hooks fail open if Echo is unavailable. |
| A conversation was not saved | Automatic capture, daily/topic rollups, skill discovery, and agentic summarization are deferred. Use explicit `remember` for selected facts. |

For the architecture boundaries and configuration reference, see [Echo setup and boundaries](../../docs/ECHO.md). Host references: [Claude hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks), and [VS Code hooks](https://code.visualstudio.com/docs/agent-customization/hooks).
