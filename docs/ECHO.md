# Echo: optional memory companion

Echo runs alongside an agent and can optionally connect its settings view to Farsight. It has its own installable package, process, configuration, and storage. Installing or running the normal Farsight CLI does not start Echo or require agentmemory.

The intended workflow is a small brief before each agent request, with source links and detail calls for further retrieval. Echo would use its own model to find and summarize relevant memories and configured skills, then capture useful memories as work proceeds. For example, a cold-storage shipping request could surface a few relevant past shipments and container decisions. Those memory claims remain separate from Farsight's code-derived graph.

## What this foundation includes

| Ready to configure and verify | Deferred |
|---|---|
| Separate personal and work profiles | Shared service authentication and team permissions |
| Managed local or explicitly configured external agentmemory | Shared hosted deployment and synchronization |
| Ollama and OpenAI-compatible model adapters; Ollama verified locally | Additional native provider adapters and provider selection policy |
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

For the first local test, choose an installed model, leave both host hooks unprepared, and accept the engine
installation. Setup writes configuration; it does not start the settings view or backend. The `personal` and
`work` profiles are both created, but setup configures only the profile selected by `--profile` or `defaultProfile`.

For scripted setup:

```sh
farsight-echo init --model your-installed-model
farsight-echo install-runtime
farsight-echo doctor
farsight-echo serve
```

Every command accepts `--config <path>` and `--profile <name>`. `init` refuses to overwrite an existing configuration. Use the scrubbed example configuration as a reference; local settings and runtime state must stay outside version control.

`serve` runs in the foreground and prints the settings URL. The view remains available if the model or memory service needs fixing. Stop with Ctrl-C; Echo shuts down only its own child processes. Externally managed memory services remain running. Restart `serve` after changing runtime settings so its active services use the saved configuration.

The default personal settings URL is `http://127.0.0.1:4480`; work uses port `4481`. Selecting work in the settings
view edits that profile and does not switch the running service. Start `serve --profile work` in another terminal
to run its distinct store. The default backend base ports are `4611` and `4711`; each managed instance also uses
base plus 1, plus 2, and plus 46023. Echo rejects configuration collisions and occupied runtime ports.

## Profiles and identity

A profile selects one individual, optional team, project, memory connection, model connection, web port, and hook preference. Personal and work profiles use distinct local stores. Within one configuration directory, a host session is bound to its selected profile and its identity/store/model configuration. Changing that boundary requires a new host session; an existing session cannot silently switch to another profile. Keep personal and work profiles in the same configuration file so their bindings use the same registry.

These identity fields are local routing metadata. They are not login, membership verification, or authorization. Run separate local instances in this phase. Do not treat an agentmemory project filter as a security boundary between teams, and do not expose the local settings service as a shared team service.

| Configuration area | Purpose |
|---|---|
| `identity` | Individual, optional team, and project labels |
| `backend` | Managed or external agentmemory connection and credential reference |
| `model` | Ollama or OpenAI-compatible provider, endpoint, model, and optional credential reference |
| `web` | Local port and optional exact Farsight origin allowed to embed the view |
| `hooks` | Whether each host may bind sessions; preparation is separate from host activation |
| `skills.directories` | Explicit future skill sources; no installation or execution |
| `budget` | Model timeout, generation limit, and final summary character limit; future briefs will use the same boundary |

Credentials are references to local secret storage, never literal keys in settings. The settings view must not return credential values. A Farsight embedding origin permits framing the view; it does not grant access to memory or connect the two graphs.

External backend setup uses a service origin and an optional `keychain:<service>/<account>` reference. For example,
`keychain:farsight/echo-example` reads service `farsight`, account `echo-example`, from macOS Keychain or Linux Secret
Service. Provision the secret through that local store, select external mode, save, restart Echo, and run `doctor`
for the selected profile. The connection must report agentmemory 0.9.30. No general external-backend write test is
provided; smoke intentionally requires managed mode.

Use a service origin as the model address, without a path: Ollama uses its chat API, and the compatible adapter
uses `/v1/chat/completions`. Compatibility is tested with a local fixture; each hosted provider still needs its own
connection check. Ollama summaries use a structured response so thinking text is not mistaken for a brief.
The final summary is capped by characters; this is not a claim about the main agent's exact token count.

## Memory runtime and storage

The dependency is pinned to published `@agentmemory/agentmemory` **0.9.30**, with native **iii engine 0.22.1**. Managed mode installs the engine under Echo's own state directory and launches the released worker with an explicit environment and profile-specific storage. It does not use upstream's interactive onboarding or modify upstream's global hook settings. Native managed mode supports macOS and Linux on arm64 and x64; other platforms require an externally managed backend.

Managed mode refuses to start if `~/.agentmemory/.env` exists: this release reads that file globally and provides no override. The refusal prevents unintended inheritance across personal and work contexts. Use a deliberately isolated external instance when that global configuration is needed elsewhere.

Managed backend credentials are generated in memory for each run; a managed profile does not accept a credential
reference. An external profile may resolve its explicit keychain reference and must report the supported
agentmemory version. Echo never adopts an existing process on its configured ports. A crash or forced kill may
leave `profiles/<profile>/echo-owner.json`: inspect its PID and all configured backend ports, stop any remaining
owned children, and remove that one lock only after confirming no writer remains. Do not delete the memory store.
Normal termination and interrupted CLI smoke tests close the owned children and remove the lock.

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

Enable one Echo profile per host session. A prepared plugin is not evidence that a host loaded it or delivered events. Automated tests exercise the generated runner with synthetic input; real host activation remains a user choice. A successfully delivered event creates session binding metadata under `.echo/sessions/`, not a captured memory. The web view's hook preferences do not prepare or install host plugins.

## Verify the setup

```sh
farsight-echo doctor
farsight-echo smoke
farsight-echo smoke --with-model
```

`doctor` checks the selected setup, Ollama model availability, and external backend identity/version when applicable.
For a managed profile it checks prerequisites without starting the backend; use the running settings view's checks
or smoke to verify readiness.
For compatible model endpoints it checks selection only; use `smoke --with-model` to verify an actual call.
The settings view also reports runtime readiness. `smoke` selects separate available ports and starts a disposable
managed store, saves and searches synthetic text, restarts on changed ports, checks persistence, then checks that a
fresh store cannot find that text. It can run in another terminal alongside `serve` and leaves the running profile's
store untouched.
`--with-model` also asks the configured model for a short synthetic summary. Smoke verification does not write to
an external backend or a personal/work memory store. Failed checks retain synthetic diagnostics in a temporary
directory; successful checks remove it. `pnpm test:echo:package` verifies the installable artifact without a model.
The model step summarizes the synthetic sample directly after the retrieval assertions; it verifies the model
connection independently and does not implement an agentic retrieve-and-summarize pipeline.

Successful output includes `remember-recall`, `restart-persistence`, and `store-isolation` with `ok: true`; the model
option adds `model-summary` and its short synthetic summary. In the web view, test saving a harmless setting and
reloading it. Restart the service to apply runtime changes. Conflicting settings edits are refused, so reload before
reapplying a change when another editor saved first.

The smoke result demonstrates package wiring and persistence. It does not establish retrieval quality, host-hook activation, shared-team security, or production summarization behavior.
