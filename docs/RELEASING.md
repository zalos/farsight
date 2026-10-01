# Releasing farsight-cli

A release is a version commit, an annotated tag `vX.Y.Z`, a `CHANGELOG.md` section and a GitHub Release
carrying the installable tarball `farsight-cli-X.Y.Z.tgz`. It is cut on demand by the **release** workflow
(`.github/workflows/release.yml`); nothing releases on push.

## Cut a release

From the repository's **Actions** tab: *release* → *Run workflow* on `main`, pick the inputs, run. Or from a
terminal with `gh`:

```sh
gh workflow run release.yml -f bump=patch                 # 0.1.0 → 0.1.1
gh workflow run release.yml -f bump=minor                 # 0.1.0 → 0.2.0
gh workflow run release.yml -f version=1.0.0              # an explicit version
gh workflow run release.yml -f bump=minor -f prerelease=beta.1   # 0.2.0-beta.1, marked pre-release
gh workflow run release.yml -f bump=patch -f dry_run=true # everything but the push and the Release
gh run watch                                              # follow it
```

| input | meaning |
|---|---|
| `bump` | `patch` (default) · `minor` · `major`, applied to the root `package.json` version; ignored when `version` is set. A bump from a prerelease finishes it (`1.0.0-beta.1` + patch → `1.0.0`). |
| `version` | an explicit `X.Y.Z`; must be after the current version |
| `prerelease` | a tag such as `beta.1`, appended as `X.Y.Z-beta.1`; the GitHub Release is marked pre-release and an npm publish goes to the `next` dist-tag |
| `dry_run` | run every step except the push, the GitHub Release and npm. Can be dispatched from any branch. |

## What the workflow does

1. Checks out the dispatched branch (`main` for a real release) with full history and tags, sets up Node from `.nvmrc` and pnpm from `packageManager`.
2. Gates: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm -r typecheck`, `pnpm test` (every package's
   suite plus `scripts/test`; the live tracker tests skip — they are opt-in by `FARSIGHT_LIVE`),
   `pnpm lint:strings`. Any failure stops the release before anything is written.
3. `node scripts/release.mjs` as `github-actions[bot]`: bumps the root `package.json`, prepends the section to
   `CHANGELOG.md`, commits `chore(release): vX.Y.Z` and creates the annotated tag, whose message is the
   release notes.
4. `node scripts/pack.mjs` **after** the version commit, so the bundle's build stamp names the release commit.
5. Smoke test: installs the tarball into a temporary npm prefix, checks that `farsight --version` prints the new
   version and the release commit, and ingests `examples/invoice-app` from a temporary directory.
6. `git push --follow-tags origin HEAD:main`, then `gh release create vX.Y.Z build/farsight-cli-X.Y.Z.tgz`
   with the notes. The job summary carries the install line.
7. npm publish, only when an `NPM_TOKEN` secret exists (below).

Only one release runs at a time (`concurrency: release`). If `main` moved while the workflow ran, the push is
refused and nothing is released; run it again.

## Install a release (consumers)

Each Release's notes carry the line; for `v0.1.1` it is:

```sh
npm install -g https://github.com/zalos/farsight/releases/download/v0.1.1/farsight-cli-0.1.1.tgz
farsight --version   # farsight 0.1.1 · built <time> · commit <sha> · packed
```

`farsight --version` (and MCP `graph_overview`, `/api/version`, the HUD sync chip) prints `version · built ·
commit`; the commit is the `chore(release)` commit the tag points at, so `git show <sha>` finds the exact
source. In an app, `npm install --save-dev <the same URL>` pins the release per project. Then follow
[GETTING-STARTED.md](GETTING-STARTED.md). Node 24 is the supported runtime.

## The scripts, by hand

The workflow is a thin shell around two zero-dependency scripts, both usable locally:

```sh
node scripts/changelog.mjs --dry-run                 # the next section and release notes, from <last tag>..HEAD
node scripts/release.mjs --dry-run --bump patch      # what a release would do, and what would stop it
node scripts/release.mjs --bump patch                # commit + tag locally (main, clean tree); never pushes
node scripts/pack.mjs                                # then push and `gh release create`, as it prints
```

- `changelog.mjs` groups conventional-commit subjects (`type(scope)!: subject`, `BREAKING CHANGE:` footers)
  under *Breaking · Features · Fixes · Docs · Tests · Chores · Other*; merge commits and earlier release
  commits are skipped; a subject that is not a conventional commit lands under *Other*. Flags: `--version`,
  `--since <tag|sha>`, `--write` (prepends to `CHANGELOG.md` below an `## [Unreleased]` head), `--notes <file>`,
  `--dry-run`. Before the first tag the range starts after the commit that seeded `CHANGELOG.md`'s newest
  section, so the first release does not repeat `[0.1.0]` — **merge release branches with `--no-ff`, not
  squash**, or that seed commit is folded into a squash and the first tagged release looks empty.
- `release.mjs` refuses a dirty tree, a branch other than `main` (without `--allow-branch`), a tag that exists
  and a version that does not move forward. Only the root `package.json` version moves: `pack.mjs` gives it to
  the tarball and core's `buildInfo()` reads it in a workspace build; `packages/*` keep their private
  workspace versions. `--trailer "Key: value"` adds a commit trailer.

## Publishing to npm (optional, later)

The workflow already has the step; it prints *npm publish skipped: no NPM_TOKEN* until a token exists.

1. On npmjs.com, create an account (or organization) that can own the `farsight-cli` name, then an
   **automation** access token (or a granular token with publish rights on `farsight-cli`).
2. In the GitHub repository: *Settings → Secrets and variables → Actions → New repository secret*, name
   `NPM_TOKEN`, paste the token. From a terminal: `gh secret set NPM_TOKEN`.
3. The next release publishes `build/farsight-cli-X.Y.Z.tgz` with `--access public --provenance` (the job has
   `id-token: write`, and the packed `package.json` names the repository, which provenance requires), on the
   `latest` dist-tag, or `next` for a prerelease. Consumers can then `npm install -g farsight-cli`.
