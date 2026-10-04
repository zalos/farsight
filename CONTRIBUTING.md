# Contributing to Farsight

Thanks for helping. This page is the short version; the project contract (principles, invariants, gotchas) is
[AGENTS.md](AGENTS.md), and it applies to people as much as to AI sessions.

## Setup

- Node 24+ (`.nvmrc` — `nvm use`) and pnpm 9 (`packageManager` in `package.json`).
- `pnpm install --frozen-lockfile && pnpm build`. **Build before tests**: every test imports compiled `dist/`.
- Install Git LFS once per machine (see [Git LFS](#git-lfs) below).

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
  server mcp cli work work-jira work-azdo work-fixture`) or the surface (`e2e scripts ci docs proposals examples
  release deps viewer skills`); a new scope is added to `SCOPES` in `scripts/lint-commits.mjs` in the same change. `!`
  after the scope or a `BREAKING CHANGE:` footer marks a breaking change. No full stop, under 120 characters.
- **Commits on the branch** are conventional too, but they are working notes — commit often, don't polish, the squash
  folds them. `pnpm install` installs a `commit-msg` hook that checks the shape (`scripts/install-hooks.mjs`, copied
  into `.git/hooks`; Git LFS's hooks stay) and sets `.gitmessage` as the commit template; `pnpm lint:commits
  --message 'fix(cli): …'` tries a subject by hand.
- Open the pull request against `main`. **CI must be green** before it is merged (`ci.yml`, see
  [docs/CI.md](docs/CI.md)): `validate`, `e2e`, `secrets`, and `commits` — the PR title against the type and scope
  lists, every branch commit for shape. Then `gh pr merge <n> --squash` (the branch is deleted on merge; keep the
  title the PR carries). A merge refused as "not up to date" wants `gh pr update-branch <n>`, never `--admin`.
- Commit messages carry no session links or private names; `Co-Authored-By:` lines are fine.

## Run what CI runs

```sh
pnpm build
pnpm -r typecheck
pnpm -r test
pnpm lint:strings      # every user-facing string goes through the catalog with both registers; glyphs via sym()
pnpm e2e               # Playwright against a real `farsight serve` on a fixture graph
```

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

Local configuration stays on your disk and is gitignored; the repository carries a scrubbed example twin of each
file. **Copy `X.example` to `X`, edit `X`, and never commit a value from it.**

| tracked example (copy from) | local file (ignored) | what it holds |
|---|---|---|
| `.farsight/settings.example.json` | `.farsight/settings.json` | workspace sources, collections, theme, work-item sources (site, scope, keychain reference) |
| `.claude/settings.local.example.json` | `.claude/settings.local.json` | Claude Code permissions (allow / deny) and env for this repo |

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
