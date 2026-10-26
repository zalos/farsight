# Contributing to Farsight

Thanks for helping. This page is the short version; the project contract (principles, invariants, gotchas) is
[AGENTS.md](AGENTS.md), and it applies to people as much as to AI sessions.

## Setup

- Node 24+ (`.nvmrc` — `nvm use`) and pnpm 9 (`packageManager` in `package.json`).
- `pnpm install --frozen-lockfile && pnpm build`. **Build before tests**: every test imports compiled `dist/`.
- Workspace dependency install scripts are allowlisted with `pnpm.onlyBuiltDependencies: ["esbuild"]`. Echo's
  dependency tree is still resolved by the workspace install, but other dependencies' build scripts are not
  approved. Echo's pinned engine is installed only by its explicit `install-runtime` command.
- Install Git LFS once per machine (see [Git LFS](#git-lfs) below).
- Keep `.npmrc`'s `uri-js` hoist exclusion: ESLint's Ajv 6 resolves its own dependency, while Sentinel's pinned
  runtime closure must not pick up fast-uri's unrelated benchmark import through pnpm's shared hoist directory.

## Branches, commits, pull requests

- One branch per change: `feat/…`, `fix/…`, `docs/…`, `chore/…`. Never commit to `main` directly — `main` is
  protected and takes pull requests only.
- **PRs are squash-merged.** One PR becomes one commit on `main`, whose subject is the **PR title** and whose message
  is the **PR body**. So the title is written as a [Conventional Commit](https://www.conventionalcommits.org/) —
  `type(scope): what changed`, e.g. `feat(server): a searchable project picker`, `fix(cli): …`, `docs: …` — and the
  body follows `.github/PULL_REQUEST_TEMPLATE.md` (*what changed · why · how it was checked · left open*). The
  changelog and release notes are generated from these subjects (`scripts/changelog.mjs`), one line per PR with a
  link to it, so write the title for the person reading the changelog.
- **Types:** `feat fix docs test chore build ci refactor perf style revert`. **Scopes:** the package (`core parsers
  server mcp cli echo work work-jira work-azdo work-fixture`) or the surface (`e2e scripts ci docs proposals examples
  release deps viewer skills agents`); a new scope is added to `SCOPES` in `scripts/lint-commits.mjs` in the same change. `!`
  after the scope or a `BREAKING CHANGE:` footer marks a breaking change. No full stop, under 120 characters.
- **Commits on the branch** are conventional too, but they are working notes — commit often, don't polish, the squash
  folds them. `pnpm install` installs lefthook's pre-commit and commit-msg hooks (`scripts/install-hooks.mjs`);
  on branches with `lefthook.yml`, pre-commit rejects main and formats/re-stages eligible JS/TS before ESLint,
  while commit-msg checks the shape. See [hook rollout and existing installs](docs/CI.md#git-hooks-and-existing-installs).
  Git LFS's hooks stay, and `.gitmessage` is the commit template; `pnpm lint:commits
  --message 'fix(cli): …'` tries a subject by hand.
- Open the pull request against `main`. **CI must be green** before it is merged (`ci.yml`, see
  [docs/CI.md](docs/CI.md)): `validate`, `e2e`, `secrets`, and `commits` — the PR title against the type and scope
  lists, every branch commit for shape. Then `gh pr merge <n> --squash` (the branch is deleted on merge; keep the
  title the PR carries). A merge refused as "not up to date" wants `gh pr update-branch <n>`, never `--admin`.
- The other existing required checks are `affected checks` and `echo-package`. The lead adds the new `lint` check
  after its first green run, bringing the total to seven; selected runtime checks run it alongside them.
- Commit messages carry no session links or private names; `Co-Authored-By:` lines are fine.

## Run what CI runs

```sh
pnpm format            # write formatter output for areas already removed from the temporary ignore block
pnpm format:check      # JS/TS; existing areas remain ignored until their style PR
pnpm lint             # fail on new ESLint errors; existing counts are frozen
pnpm lint:report      # include structure warnings; pnpm lint --prune-suppressions removes fixed debt
pnpm build
pnpm -r typecheck
pnpm -r test
pnpm lint:strings      # every user-facing string goes through the catalog with both registers; glyphs via sym()
pnpm e2e               # Playwright against a real `farsight serve` on a fixture graph
```

Per-PR checklist:

- [ ] `pnpm format:check` and `pnpm lint` pass.
- [ ] Affected checks in [docs/CI.md](docs/CI.md) pass; lint the exact Conventional Commit PR title.
- [ ] A `style:` PR contains only formatter output and its area's temporary ignore-line removal; generated files,
  pinned inputs and string catalogs stay excluded.
- [ ] For a `style:` PR, `pnpm verify:format -- <merge-base> <head>` reports no changed programs or
  added/deleted/renamed JS/TS files. Review comment warnings (`--strict-comments` makes them fail).

Linked worktrees share one hooks directory: never add Git LFS hook names (`pre-push`, `post-checkout`, `post-commit`,
`post-merge`) to `lefthook.yml`; keep `no_auto_install: true` so a commit cannot rewrite everyone's hooks.
Never pop a `lefthook auto backup` stash entry. Run `pnpm install` in a new worktree before committing.

## Where things live

| | |
|---|---|
| [README.md](README.md) | what Farsight is, install, repository layout |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | user walkthrough: ingest, serve, MCP, config |
| [docs/VISION.md](docs/VISION.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/ROADMAP.md](docs/ROADMAP.md) | why, the design and its ADRs, what is done and next |
| [docs/MAP-PACKAGES.md](docs/MAP-PACKAGES.md) · [docs/MAP-VIEWER.md](docs/MAP-VIEWER.md) | where code lives, package by package and module by module |
| [docs/COUNTS.md](docs/COUNTS.md) | every number the product prints and what it counts |
| [docs/contracts/](docs/contracts/) + [schemas/](schemas/) | the frozen machine-readable contracts (additive-only) |
| [docs/proposals/](docs/proposals/) | how a design was argued before it was built |
| [docs/RELEASING.md](docs/RELEASING.md) · [CHANGELOG.md](CHANGELOG.md) | how releases are cut, what changed |

## This repository is public

No client names, real people, real company names, emails, site or org URLs, keychain account names or absolute
home paths — in code, fixtures, docs or commit messages. Examples use a fictional cast (Acme Widgets, Globex,
Initech; Ada Okafor, Ben Lindqvist, Pat Reviewer) and reserved names (`example.com`, `*.test`,
`example.atlassian.net`, `dev.azure.com/example-org`). Secrets live in the OS keychain and are referenced as
`keychain:farsight/<provider>-<instance>`, never as a value in a file or an environment variable.

## Local config

After pulling this change into an existing worktree, run `pnpm install --config.confirm-modules-purge=false` once.
The `.npmrc` hoist settings require pnpm 9 to purge `node_modules`; in a non-TTY shell its confirmation can silently
exit 0 without installing. The flag allows that purge and completes the install. CI's fresh install is unaffected.

Local configuration stays on your disk and is gitignored; the repository carries a scrubbed example twin of each
file. **Copy `X.example` to `X`, edit `X`, and never commit a value from it.**

| tracked example (copy from) | local file (ignored) | what it holds |
|---|---|---|
| `.farsight/settings.example.json` | `.farsight/settings.json` | workspace sources, collections, theme, work-item sources (site, scope, keychain reference) |
| `.claude/settings.local.example.json` | `.claude/settings.local.json` | Claude Code permissions (allow / deny) and env for this repo |
| `.echo/settings.example.json` | `.echo/settings.json` | Echo profiles, identities, ports, model selection and Echo-only keychain references |
| `.echo/connection.example.json` | `.echo/connection.json` | one workspace's selected Echo configuration and profile; no copied memories or credentials |

Echo also requires a user-owned trust receipt for the exact settings and connection files. Prefer `farsight-echo
init` / `setup` and `connect` to create these local files; a copied example is review material until it is
explicitly adopted through Echo. Settings-view edits maintain the receipt. Review a manually edited settings
file before `farsight-echo trust --confirm`, and recreate connection pointers with `connect`.

Echo's generated `.codex/hooks.json` and `.github/hooks/echo.json` contain machine-specific paths and are local,
not team configuration. Hook installation adds local Git excludes for these paths, Claude's local settings and
`.echo/*` (preserving the two example twins), verifies they are ignored, and refuses already tracked targets.
It leaves shared ignore files alone. `disconnect` removes Echo-owned hooks, restoring exact original bytes when
there have been no later edits; its restoration records stay outside the repository in private user state.

The other tracked configs are shared and generic — no personal values, relative paths only: `.mcp.json` and
`.codex/config.toml` (the workspace MCP server: `node packages/cli/dist/cli.js mcp --graph graph.json`),
`.claude/launch.json` (the viewer on port 4477), `farsight.config.json` (this repo's tags, glossary and test
reports), `compliance.yml` (the dogfood gate policy).

## Git LFS

Binary files are stored with [Git LFS](https://git-lfs.com). `.gitattributes` routes `*.png *.jpg *.jpeg *.gif
*.webp *.pdf *.zip *.tgz *.wasm *.woff *.woff2 *.mp4` through it; CI checks out with `lfs: true`.

```sh
git lfs install          # once per machine (installs the hooks)
git lfs ls-files         # which tracked files are in LFS
git lfs status           # what a commit will send to LFS
```

Add a new binary type to `.gitattributes` *before* the first file of that type is committed; moving an
already-committed file into LFS rewrites history (`git lfs migrate`) and needs the owner.

## License

The repository does not carry a license file yet; the owner will choose one. Until then, ask before reusing code
outside this project.
