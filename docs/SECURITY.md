# Security

Farsight is a local developer tool. It reads code on your machine. It serves what it found to you, to your
agents and to your shell. With your own credential, it reads and writes the trackers you configure. This page
covers what it trusts, what it refuses, and how to report a problem.

## Independently packaged parser

`@farsight/code-parser`'s `parseRepository` API runs the existing Oxc and Tree-sitter adapters under a bounded,
per-call read context. It refuses symlink components and paths outside the explicit source root, caches the bytes
it parses, and fingerprints configuration/resolution inputs. It neither executes the source nor enables external
Farsight enrichment. Resource-limit, parse, unsupported-input and cancellation diagnostics remain in the artifact.
Time limits/cancellation are cooperative between synchronous operations, not process isolation; custom adapters
are trusted code. Analyze a stable checkout: this is not an atomic filesystem snapshot or a security verdict.
The compatibility `extractRepository` API retains the application's legacy IO semantics. See
[PARSER-LIBRARIES.md](PARSER-LIBRARIES.md) and the parser README for the API boundary and defaults.

## Sentinel's separate package

Sentinel (`packages/sentinel`, ADR 18) is optional and ships as its own `farsight-sentinel` tarball.
`farsight-cli` does not bundle, import or start it, so installing Farsight installs no scanner, container client
or model SDK; the `sentinel-package` CI job checks the CLI bundle and a clean consumer for that. The current
package defines draft contracts, a draft local store and a placeholder command that claims no scanning support.
It reads no source, resolves no credential and makes no network calls; the policy library reads only the settings, repository intent, rule-pack files and user-state records it is pointed at (below).

The store (`openStore`, ADR 19) writes only inside the folder it is given, and only after checking it: absolute and
already canonical (no link, alias, dot segment or other letter case), every folder above it owned by the user or
root and not writable by others unless sticky, the folder 0700 and its files 0600 with one link each (existing
broader permissions are refused, never changed), on a file system the path checks identify as local, and for an exact host and SQLite pair the release policy lists (darwin-arm64 with SQLite 3.53.3 or 3.53.4 on APFS measured; linux-x64 with SQLite 3.53.4 on Node 24.21.0/ext4 measured ([CI evidence](https://github.com/zalos/farsight/actions/runs/39723522049/job/119642215934)); other allowlisted file system types unmeasured; every other pair refused). On macOS that identification runs
`/sbin/mount` once with no shell, an empty environment and a 5 s bound; nothing else is spawned. One process owns
a store at a time through an OS file lock on `owner.sqlite`, which is never deleted and never opened by anything
else; `owner.json` only describes the holder. Records from an earlier owner's epoch are refused. Evidence objects
are immutable and content-addressed; a publication is accepted only after their bytes are re-read and hashed, and
the ledger keeps schema, privacy class and links per reference, so shared bytes cannot lower a reference's class.
Nothing is deleted automatically; the prune plan is a dry run, and never lists the provenance (manifest, invocation, outputs, diagnostics) of a retained work or attempt record. The store does not supply credentials or trusted settings;
privately retained source can contain secrets, workspace settings and local caches. Capturing those bytes never
adopts them as authority. Durability is claimed against process death, not power loss (ADR 19).

A capture (ADR 46) leaves out only the store this process holds, at its exact canonical folder with the identity
it was opened with; the store reached under another name, replaced, renamed or released refuses the capture, and no
folder is left out by its name. A run's scratch is a lease inside that store. Release removes only a container
client configuration folder the execution layer made for that lease, after every client it started exited; any
other folder or file keeps the lease. Removal is bounded and checks the hold and the folders before every step;
anything uncertain is kept. Old retained leases survive service restart; the current service reports only leases
retained during its own lifetime, and no old-epoch sweep is implemented. Path-based removal under an active
same-account race is detection, not confinement. Owner trust state and the service's runtime folder are checked
against the captured workspace before anything is made, and a selected location inside it is refused.

Trusted policy (ADR 23) reads `.farsight/sentinel/settings.json` and the repository's `sentinel.config.json` as data,
never following a link. The settings hold keychain references only (`keychain:farsight/<name>`); a value shaped like a
credential anywhere else is refused and not repeated in the error. The file grants nothing until the owner adopts its
exact bytes for the canonical workspace; the adoption record and every receipt are owner-only files in user state
outside the checkout, and a changed byte, clone, moved checkout or re-created folder loses the adoption. Repository
files can request rules and stricter thresholds; they cannot remove a mandatory rule, weaken a threshold, approve a
suppression or select a provider. Only a redacted effective policy (no endpoint, credential reference or raw bytes) is
served. Admission ANDs policy, adapter capability and credential authority, asks nothing after a policy denial, and
keeps owner actions (approvals, rule promotion, tool and database records, settings adoption) away from agents. A
human receipt is bound to one exact action, input, effect set, budget, scope, state and policy revision, lives at
most an hour and is spent once; no package export can issue one, so agent-facing surfaces can only ask. Rule packs
are data: a script-shaped rule implementation, a link or an escaping path is refused, nothing in a pack is executed,
and recording a tool digest in the lock authorizes no download or execution. As with the store, code running as the
owner's own account is outside this boundary. The Trivy adapter (ADR 33) runs the pinned
image only through the isolated execution service, with no network, and reads no repository ignore file. Its checks
bundle is fetched only by the owner's confirmed acquisition, by digest, from the allowlisted registry, with no inherited
login (an anonymous pull token that is never sent to the blob host); scans never download. The engine's log stays in
the container: only fixed words, digits and the job's own paths leave it. The zizmor adapter (ADR 34) runs offline
with no token, no repository configuration and no ignore comments; the audits that would need the GitHub API are
reported as skipped, never as passed.
The Nest framework pack (ADR 32) reads only captured bytes from the store and the parser's artifact; it parses them
as data and never imports, installs or runs the target or its package manager. Guard and pipe names are never read
as protection, and a registration it cannot follow is reported as a frontier, not resolved. Sentinel's local folder
(`.farsight/sentinel/*`) is ignored by git. Later scanner, container and model work arrives with its
own trust-boundary section here: external scanners run only in containers, with no host fallback, and model
providers are opt-in per run. The pattern adapter (PR 10) is the first external scanner: Semgrep 1.181.0, the image pinned by
digest and installed ahead (never pulled), run only through the isolated execution service with no network, a
read-only root, a non-root user and inputs read-only. An original shim inside the container, pinned by digest in the
adapter's fixed command, runs the engine with telemetry and version checks off and only the open-source engine;
repository ignore files are never materialized, in-source suppression comments are disabled, and a captured file
shaped like a job makes the worker refuse rather than run it. A failed engine run is reported only as a fixed category and its exit code, never its messages, which
can quote source text. Results are trusted only after the coordinator checks them against the job it supplied and the
captured bytes; engine fingerprints and messages are not used, and findings
keep spans and digests, not source text.

Dependency advisories (PR 12): the advisory database is downloaded only by an explicit,
owner-confirmed acquisition, from one allowlisted origin (the OSV project's published archives), size-bounded, with the
origin's MD5 checked and the archive stored by digest in an owner-only folder; scans run OSV-Scanner fully offline with
no network and never download, and no project package manager runs. Engine stderr never leaves its container; the
dependency fixtures are original synthetic files under non-manifest names, and no database ships in the package.

Model providers and review (ADRs 35, 39) are opt-in and run in process; no scanner, worker or repository code calls
a model.
- **Who may be called.** Only a provider and model in the adopted settings can be called. A local-only provider must
  be a literal loopback address; a hosted one must use https and have recorded retention and training terms.
- **The owner's confirmation.** The owner's receipt confirms the exact origin, credential reference, disclosure,
  model, limits, price, terms and probed capability, and the run's budget. Any change, including any policy change,
  stops further calls.
- **Credentials.** A credential is read from the OS keychain (`keychain:farsight/<name>`, through core's reader) in
  the broker's own process, only after the policy has allowed the call. It is held in a value that prints and
  serializes as redacted and sent only as the `Authorization` header to that one origin; no error, record or log
  carries it.
- **Transport.** Redirects are never followed, certificates are always verified, and requests, responses, time and
  context are bounded. No provider-returned text (model names, error bodies) reaches a public error.
- **Disclosure.** It is bounded by the review's scope: a model sees only bounded line slices of the files its session
  was given, as data marked untrusted, through a fixed reply grammar with no tool, target, disclosure or approval
  power. Files a withheld secret-location citation names are removed from review whole, path included.
- **External-stage selection.** Hosted review requires complete accepted current-source secret coverage by default.
  An owner may explicitly adopt `hostedReviewSecretScan: "when-selected"` for agentic-only review without an
  external scanner. If the secret rule is selected, its existing complete-coverage gate still applies even when
  missing assets prevented a scan from being planned. Known accepted secrets still withhold review across current,
  baseline and proven selected ancestry. Omitting the scan makes no secret-free or deterministic coverage claim;
  source-disclosure, network and paid-inference admission remain required. Selected external scanners remain
  container-only, with no automatic acquisition or host fallback.
- **Spend.** The worst case is reserved in a durable ledger before a request leaves. A call that may have been
  charged stays charged until the owner reconciles it with a receipt, and recovery fences a crashed coordinator's
  epoch so it can neither spend nor write again.
- **Tests.** Ordinary tests use local mock endpoints and in-memory credentials. The one live test is opt-in and only
  lists the models of a local Ollama.

The secret scan (ADR 28) runs the pinned official Gitleaks image only inside its container, behind an original shell
shim, over a rebuilt copy of the captured files, with a pinned configuration and no repository ignore list, baseline
or inline allow. Matched values never leave the container: the tool's messages and raw output stay there, its report
names only the rule, lines and a job index (no path), and each observation keeps only the detector, the file and whole
lines. No result prints a file name: a name can hold a secret no detector recognises out of context, so every finding cites
the file by its place in the captured snapshot (`WithheldLocationEvidence`), and only the private snapshot resolves it,
exactly, through one bounded resolver. Names the engine finds secret-shaped are reported as findings themselves. A folder the engine's own allowlist prunes is listed as skipped, with everything in it.
A tool error, an unreadable report or a file that was
not scanned is a failed or partial scan, never a clean one. The image is installed by digest ahead of time (CI pulls
it in the isolation job); a scan never pulls. Its tests assemble an inert synthetic token at run time, so the
repository's own secret scan needs no allowlist for it, and no assertion or report prints it. The package smokes install from npm into temporary directories with their own npm
cache and user config/state, and start nothing beyond the packaged command and a read-only Farsight server on a
free loopback port.

## Threat model

| part | who can reach it | what guards it |
|---|---|---|
| **viewer server** (`farsight serve`, default :4477) | processes on this machine; web pages open in your browser | binds `127.0.0.1` only. Answers loopback `Host` names only (`localhost`, `127.0.0.1`, `[::1]`), so a DNS-rebinding page gets 403. Refuses a `POST`/`PUT`/`DELETE` whose `Origin` or `Sec-Fetch-Site` names another origin, so another site cannot start a sync, rewrite settings or queue a tracker write. Never sends CORS headers, so another origin cannot read a response. (`packages/server/src/guard.ts`) |
| **MCP server** (`farsight mcp`) | the client that spawned it, over stdio | no network listener. Its tracker writes are stamped `requestedBy.kind: 'agent'` and go through the same gate as the viewer's. Of `.farsight/settings.json` it reads `sources` (for work and code-host sources) and, for the session-start context (`farsight://context`, `graph_overview brief:true`), **only** `mcp.tools`, `mcp.budget` and `lessons` (`packages/mcp/src/context.ts readAgentSettings` drops every other field unread), so a source, its `auth` block or a keychain reference never reaches an agent through the context — `test/mcp-agents.test.ts` asserts it. Lessons are written by a person on the Settings page; no tool writes them, and `PUT /api/settings` refuses a lesson shaped like a credential (a keychain or env reference, a bearer/basic header, a long unbroken token) without echoing it. The core tool tier (the default) is read-only. |
| **CLI** | you | — |
| **secrets** | this process only | settings hold a *reference* (`keychain:farsight/<provider>-<instance>`, or `env:NAME` for tests and CI), never a value. `packages/work/src/secrets.ts` resolves it in process with `security` (macOS) or `secret-tool` (Linux). `PUT /api/settings` refuses an `auth.secret` that is not a reference, without echoing what was sent. Errors name the reference, never the value. The Jira client scrubs the token and the encoded header from any error text it keeps. Only response bodies are recorded as fixtures or stored as an item's `raw`; request headers never are. |
| **trackers** (Jira, Azure DevOps) | reached with your credential | a write needs three verdicts: the workspace policy (`permissions`), the tracker's own answer for this item and action, and a usable credential. A source is `read-only` unless its settings say `edit`. |
| **code hosts** (GitHub) | reached with your credential: `keychain:farsight/github-<org>` on a `type: 'code-host'` source, read in process; the GitHub CLI's own login **only** when you pass `--via gh` | `farsight affected --post` writes one comment (found again by its marker line and edited in place) and one commit status, through the same three verdicts as a tracker write (the source's `allow.people` / `allow.agents` and `mode: 'edit'` — default deny · the host says the pull request is open and the credential may push · the credential is accepted) and `--confirm`. MCP `affected` reads only, and is registered only when a source grants agents `read`. Azure DevOps posting is refused with words (not built). |
| **Echo portal and settings** (`farsight-echo serve`, workspace defaults :4480/:4481; global defaults :4490/:4491) | processes on this machine; the local memory/settings page | binds `127.0.0.1`. Checks the exact loopback `Host` and port, `Origin`, and `Sec-Fetch-Site`; settings writes require JSON, a body no larger than 64 KB, and the current `If-Match` revision. Cross-process locking prevents a stale browser or CLI update from silently overwriting another edit. No CORS headers; CSP permits embedding only by the explicitly configured local Farsight origin. A permitted frame can navigate to the HTML shell, but data requests still require the Echo origin. Read-only memory requests are bound to the trusted startup profile and rechecked before returning. Responses contain credential references, never resolved values. (`echo/src/web.ts`, `settings-lock.ts`) |
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

**Model setup is explicit and uses saved settings.** `POST /api/model/models` and `/api/model/test` accept only a profile ID and the current `If-Match` settings revision. The server loads and verifies the saved configuration, applies the existing address and credential-origin policies, and rechecks the revision before returning. Requests cannot supply arbitrary prompts, endpoints, headers or credentials. Discovery reads model metadata; testing sends fixed synthetic evidence once and validates a strict reply. Neither reads user memory or starts the memory engine. The synthetic preview refuses both operations. Disconnects and deadlines cancel work, and responses contain only allowlisted identity/status/usage fields or catalog errors. A process-owned gate prevents a setup test from overlapping model research in that service; separate CLI processes and independently started services still rely on the provider's own concurrency controls.

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

**Sub-mind research is explicit and read-only.** New and legacy profiles default to off. Mock research
never reaches a model; the standalone text demo has no network or backend dependency, while the portal demo uses only its own local web server and private bridge. In model mode,
explicit questions and selected memory evidence are sent to the configured endpoint. The controller enforces
per-request candidate, search, input, output and deadline limits, validates citations against inspected records,
and constructs follow-up actions itself. It has no mutation or shell tools. The private bridge admits one research
job per profile process, aborts disconnected callers, and rechecks settings before returning results. Both normal
and exact-id reads verify the complete profile namespace. A content hash detects changed evidence; it is not a
promise of retained historical revisions. Search coverage remains non-exhaustive because the pinned backend
ranks globally before applying scope filters. Requests with no provider usage report unknown token totals.

Models may use a remote HTTPS API or a localhost tunnel. The explicit model-only allowInsecureHttp setting
permits canonical private IPv4 literals in RFC1918 ranges; public HTTP and remote DNS names remain refused.
The exception refuses credentials on remote plaintext transport, but questions and evidence are still unencrypted.
It does not change backend endpoint policy, expose the local bridge, or manage the remote model service.
Settings loads and provider dispatch both enforce this policy. Research policy and all budgets are included in
session fingerprints, so upgrading or changing them requires a fresh session and service restart. Legacy hooks remain bounded raw recall. The separate `submind.hookResearch` opt-in offers background or wait behavior. Background hooks return a small engine-created handle; wait hooks may include complete sourced findings and checked expansion actions, bounded by the context allowance. Waiting is capped at sixty seconds and falls back to that handle. Saved settings alone never generate.

Background work uses a server-owned cancellation controller rather than the submission socket. Jobs require a trusted workspace connection and an immutable host/session binding in addition to the startup fingerprint. Polling and cancellation require that same binding and an opaque request identifier; polling never runs inference. Results expire after five minutes, are capped at sixteen retained jobs and 256 KiB, and are discarded on restart. A newer prompt cancels active work in its own session; competing work receives busy rather than queuing. Cancellation retains the model operation gate until the provider actually settles. Changed configuration/connection refuses stale results. No background job saves a transcript or acquires write authority. Brief waits retain at most 31 listeners, revalidate trust after waiting, and never initiate inference. A wait disconnect or deadline removes only the waiter; job cancellation remains explicit. Installed runners advertise their timeout capacity, while older runners keep their original short deadline.

**The memory portal reads only the running scope.** The local `POST /api/memory/browse`,
`POST /api/memory/expand`, and `POST /api/memory/ask` routes share the host/origin/fetch-site guard and require
bounded JSON requests. There is no memory edit/delete route. The server reads trusted settings and checks the
startup fingerprint before and after asynchronous work; a changed running identity, connection or policy
refuses the result until restart. Selecting another settings profile is never a memory scope input. Browser
cancellation, disconnect and deadlines propagate through reads and private-bridge research.

Browse continuations are signed with a per-process secret and bound to the startup scope, query and date
selection. Upstream global topic facets are not exposed. Every returned record is checked
against the exact namespace and individual scope. Upstream responses are capped at 2 MB; only oversized pages
retry with limits of 50, 10, then one, within one deadline. Returned title/content/topic text shares a
64,000-character page allowance. Date filtering can produce an empty page with a continuation; pagination and
queried ranking do not establish a complete or stable snapshot. Exact detail reads check a content-bound revision
and label changed or missing evidence rather than promising historical versions.

The browser renders saved/model text with text content, never executable HTML or Markdown, and follows only
checked read-more actions with an ID and revision. Search content is kept out of URLs and browser storage.
Ordinary browsing and detail reads never generate; only explicit research invokes the running mode. Off disables
research, mock uses deterministic excerpts, and model mode can send selected evidence to the configured provider.
The portal is a local read boundary, not a shared-team authentication system.

**The portal preview is disposable.** `portal-demo` starts the same UI and private bridge with synthetic records,
mock research, temporary configuration and a temporary trust registry. It does not load existing Echo settings,
resolve real credentials, start agentmemory/iii, or contact a model or memory backend. The preview binds a local
port (default 4491; zero selects an available port), labels itself synthetic, and refuses settings writes. Normal
shutdown closes its listeners and deletes its temporary state; forced process termination can leave temporary
files for inspection. It does not change the user's saved configuration or trust registry.

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

Workspace OpenAPI registration (`POST /api/sources/:id/openapi`) and dismissal (`DELETE /api/sources/:id/openapi?path=…`) write only `.farsight/settings.json` and pass through the same request and read-only guards. A registered spec URL is fetched when the source syncs; registration itself does not fetch it. `POST /api/settings/check` validates a draft without saving and remains available on read-only and historical servers. File references are confined to their source; workspace overlays cannot add path blocks.

**Pattern rules are bounded data, never executable adapters.** `patterns[]` reads only files selected by its globs
inside the source, with workspace excludes and ignore rules applied; a nested config scopes its rules to its folder.
The pass refuses traversal globs, symbolic file replacements and paths resolving outside the source. Files are at most
1 MiB; regex source is at most 512 characters; a source admits 64 rules across root, workspace overlay and nested files.
Each rule processes selected files in sorted path order, up to 2048 files or 64 MiB of source text. Each selected file is
read and parsed once, sharing its syntax tree across applicable rules, then disposing it. These deterministic input caps
are the normal stopping conditions. A thirty-second per-rule safety budget checks between files and supplies the remaining
`timeoutMicros` to Tree-sitter traversal. Every budget stop is reported during sync, even if earlier files matched.

Raw query source is capped at 4096 characters and every query string literal, including regex predicate patterns, at 512
source characters before compilation. Query `matchLimit` caps in-progress Tree-sitter match states, not total returned
matches. Neither Tree-sitter's traversal timeout nor the between-file budget preempts a JavaScript regex or query predicate
already running. Input and expression-length caps limit that exposure; they do not guarantee a regex execution deadline.
Previews retain at most fourteen source lines (plus the truncation marker) and 4096 characters. Dry-run responses return at
most 1000 match details, selecting unresolved matches first, with explicit returned and omitted counts. No process is spawned,
no code or grammar is installed, evaluated or fetched, and no file outside the source is read by the pattern pass.

`patterns test`, `patterns_test` and `GET /api/patterns/test` read today's local source without writing a graph, source file
or snapshot. A source with no selected rule returns before adapter extraction. The HTTP route admits one dry run per source
at a time and returns 409 to competing requests. It remains available on read-only and historical servers, but is a named
cost-bearing GET in the loopback request guard: a foreign `Origin` or `Sec-Fetch-Site` is refused before parsing begins.
Same-origin browser requests and local CLI clients without those headers retain access.
