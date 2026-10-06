# Security

Farsight is a local developer tool. It reads code on your machine. It serves what it found to you, to your
agents and to your shell. With your own credential, it reads and writes the trackers you configure. This page
covers what it trusts, what it refuses, and how to report a problem.

## Threat model

| part | who can reach it | what guards it |
|---|---|---|
| **viewer server** (`farsight serve`, default :4477) | processes on this machine; web pages open in your browser | binds `127.0.0.1` only. Answers loopback `Host` names only (`localhost`, `127.0.0.1`, `[::1]`), so a DNS-rebinding page gets 403. Refuses a `POST`/`PUT` whose `Origin` or `Sec-Fetch-Site` names another origin, so another site cannot start a sync, rewrite settings or queue a tracker write. Never sends CORS headers, so another origin cannot read a response. (`packages/server/src/guard.ts`) |
| **MCP server** (`farsight mcp`) | the client that spawned it, over stdio | no network listener. Its tracker writes are stamped `requestedBy.kind: 'agent'` and go through the same gate as the viewer's. |
| **CLI** | you | — |
| **secrets** | this process only | settings hold a *reference* (`keychain:farsight/<provider>-<instance>`, or `env:NAME` for tests and CI), never a value. `packages/work/src/secrets.ts` resolves it in process with `security` (macOS) or `secret-tool` (Linux). `PUT /api/settings` refuses an `auth.secret` that is not a reference, without echoing what was sent. Errors name the reference, never the value. The Jira client scrubs the token and the encoded header from any error text it keeps. Only response bodies are recorded as fixtures or stored as an item's `raw`; request headers never are. |
| **trackers** (Jira, Azure DevOps) | reached with your credential | a write needs three verdicts: the workspace policy (`permissions`), the tracker's own answer for this item and action, and a usable credential. A source is `read-only` unless its settings say `edit`. |

The server trusts any process that runs as you. That process can already read your files and run `git`, so
it is inside the boundary. The guard draws the line at other web origins, not at other local programs.

**`requestedBy` over HTTP is a claim, not an identity.** The viewer's write routes take the principal from
the request body (`human` unless it says `agent`), so a local program can say it is a person. Inside the
boundary above, this is by design: the policy's `human`/`agent` grants guard against mistakes, not against a
hostile local process. An agent that should not write as a person must reach trackers only through MCP.

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
