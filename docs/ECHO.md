# Echo: optional memory companion

Echo runs alongside an agent and can optionally connect its settings view to Farsight. It has its own installable package, process, configuration, and storage. Installing or running the normal Farsight CLI does not start Echo or require agentmemory.

The intended workflow is a small brief before each agent request, with source links and detail calls for further retrieval. Echo would use its own model to find and summarize relevant memories and configured skills, then capture useful memories as work proceeds. For example, a cold-storage shipping request could surface a few relevant past shipments and container decisions. Those memory claims remain separate from Farsight's code-derived graph.

## What this foundation includes

| Ready to configure and verify | Deferred |
|---|---|
| Separate personal and work profiles | Shared service authentication and team permissions |
| Managed local or explicitly configured external agentmemory | Shared hosted deployment and synchronization |
| Ollama model connection and synthetic summary check | Additional model adapters and provider selection policy |
| Standalone local settings view with an allowed Farsight embedding origin | A Farsight navigation entry and integrated memory viewer |
| Optional prepared Claude Code and Codex hook plugins | Automatic capture, memory briefs, follow-up retrieval tools |
| Configured skill directories | Skill discovery, installation, and execution |
| Synthetic save, search, restart, and isolation verification | Production retention, daily/topic rollups, and memory review |

## Install and configure

Use Node 24 or newer. For source development, use pnpm 9:

```sh
pnpm install
pnpm build
node packages/echo/dist/cli.js setup
```

For a standalone install, `pnpm pack:echo` creates `build/echo/farsight-echo-<version>.tgz`. Install that file with npm, then run `farsight-echo setup`. Echo is packaged separately; this command does not publish it.

Interactive setup creates `.echo/settings.json` if needed, offers installed Ollama models, asks separately whether to prepare each host's hooks, and offers installation of the pinned local engine. Answers default to no for hooks and engine installation. If no model is installed, setup explains how to download one explicitly. Echo does not choose and download a model silently.

For scripted setup:

```sh
farsight-echo init --model your-installed-model
farsight-echo install-runtime
farsight-echo doctor
farsight-echo serve
```

Every command accepts `--config <path>` and `--profile <name>`. `init` refuses to overwrite an existing configuration. Use the scrubbed example configuration as a reference; local settings and runtime state must stay outside version control.

`serve` runs in the foreground and prints the settings URL. The view remains available if the model or memory service needs fixing. Stop with Ctrl-C; Echo shuts down only its own child processes. Externally managed memory services remain running. Restart `serve` after changing runtime settings so its active services use the saved configuration.

## Profiles and identity

A profile selects one individual, optional team, project, memory connection, model connection, web port, and hook preference. Personal and work profiles use distinct local stores. A host session is bound to its selected profile and its identity/store/model configuration. Changing that boundary requires a new host session; an existing session cannot silently switch to another profile.

These identity fields are local routing metadata. They are not login, membership verification, or authorization. Run separate local instances in this phase. Do not treat an agentmemory project filter as a security boundary between teams, and do not expose the local settings service as a shared team service.

| Configuration area | Purpose |
|---|---|
| `identity` | Individual, optional team, and project labels |
| `backend` | Managed or external agentmemory connection and credential reference |
| `model` | Selected provider, endpoint, model, and optional credential reference; Ollama is implemented first |
| `web` | Local port and optional exact Farsight origin allowed to embed the view |
| `hooks` | Whether each host may bind sessions; preparation is separate from host activation |
| `skills.directories` | Explicit future skill sources; no installation or execution |
| `budget` | Model timeout and output limit; brief size is reserved for the future brief pipeline |

Credentials are references to local secret storage, never literal keys in settings. The settings view must not return credential values. A Farsight embedding origin permits framing the view; it does not grant access to memory or connect the two graphs.

## Memory runtime and storage

The dependency is pinned to published `@agentmemory/agentmemory` **0.9.30**, with native **iii engine 0.22.1**. Managed mode installs the engine under Echo's own state directory and launches the released worker with an explicit environment and profile-specific storage. It does not use upstream's interactive onboarding or modify upstream's global hook settings. Native managed mode supports macOS and Linux on arm64 and x64; other platforms require an externally managed backend.

Managed mode refuses to start if `~/.agentmemory/.env` exists: this release reads that file globally and provides no override. The refusal prevents unintended inheritance across personal and work contexts. Use a deliberately isolated external instance when that global configuration is needed elsewhere.

Agentmemory persists its records through iii's file-backed state store. Echo's memory data is runtime state, not a Git merge format. Commit scrubbed configuration examples and documentation; do not commit live stores. External mode connects to an instance the user manages and does not start or stop it. A future hosted team service will need authentication and enforced tenant boundaries.

Agentmemory can store and search without an external model API. In this foundation, the backend handles storage and recall; Echo's selected Ollama model handles the optional synthetic summary check. Engine/package installation requires downloads. Local model inference does not require a hosted model API, although a model may need an initial download. Future brief generation still consumes sidecar compute, and any brief injected into a main agent will consume that agent's context.

## Optional host hooks

Package installation does not prompt or install hooks. `setup` asks about preparation, or use an explicit command:

```sh
farsight-echo hooks --host claude --profile personal
farsight-echo hooks --host codex --profile personal
```

Each command creates reviewable files under `.echo/plugins/<profile>/<host>/` and prints loading instructions. The runner forwards event input to Echo with a fixed configuration and profile. The foundation records the session binding and discards conversation content. It does not call a model, search memory, or inject context.

The prepared events are `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, and `Stop`. Hook commands have short time limits. Hooks currently target macOS and Linux. Keep the installed Echo executable and configuration at their generated locations, or prepare the plugin again after moving them.

For Claude Code, review the generated files and start a new session with `claude --plugin-dir <generated-directory>`. Claude discovers `hooks/hooks.json`; the manifest does not register it a second time. See [Claude plugin manifests](https://code.claude.com/docs/en/plugins-reference) and [hook events](https://code.claude.com/docs/en/hooks).

For Codex, review the generated files and register their local marketplace with `codex plugin marketplace add <generated-directory>`. Restart the desktop app, install the plugin from that marketplace, and review and trust its hooks. Marketplace registration, plugin installation, and hook trust are separate steps. Admin policy may prevent non-managed hooks. See [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) and [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Enable one Echo profile per host session. A prepared plugin is not evidence that a host loaded it or delivered events. Automated tests exercise the generated runner with synthetic input; real host activation remains a user choice.

## Verify the setup

```sh
farsight-echo doctor
farsight-echo smoke
farsight-echo smoke --with-model
```

`doctor` checks the selected setup and model availability. The settings view also reports runtime readiness. `smoke` starts a disposable managed store, saves and searches synthetic text, restarts the service, checks persistence, then checks that a fresh store cannot find that text. `--with-model` also asks the configured Ollama model for a short synthetic summary. Smoke verification does not write to an external backend or a personal/work memory store.

The smoke result demonstrates package wiring and persistence. It does not establish retrieval quality, host-hook activation, shared-team security, or production summarization behavior.
