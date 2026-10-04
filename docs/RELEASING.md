# Releasing farsight-cli

A release is a version commit `chore(release): vX.Y.Z`, an annotated tag `vX.Y.Z` on that commit, a
`CHANGELOG.md` section and a GitHub Release carrying the installable tarball `farsight-cli-X.Y.Z.tgz`.

`main` is protected: no direct pushes, pull requests only, the `validate` and `e2e` checks required, enforced
for admins and for the Actions token. So a release goes through a **release PR**, in two workflows:

| workflow | trigger | permissions | what it does |
|---|---|---|---|
| **release** (`.github/workflows/release.yml`) | `workflow_dispatch`, from `main` | `contents: write` (pushes `release/vX.Y.Z`, never `main`) · `pull-requests: write` | gates → version commit on a new branch `release/vX.Y.Z` → pack + smoke test → push the branch → open the PR `chore(release): vX.Y.Z` labelled `release`, the release notes as its body |
| **publish** (`.github/workflows/publish.yml`) | every `push` to `main`; does real work only when the push brings in `chore(release): vX.Y.Z` for the version `package.json` now carries | `contents: write` (tag + Release) · `id-token: write` (npm provenance) | gates → pack + smoke test → annotated tag `vX.Y.Z` on the release commit → GitHub Release with the tarball → npm (optional) |

Nothing releases on an ordinary push: publish's `detect` job finds no release commit and stops in seconds.

## Cut a release

From the repository's **Actions** tab: *release* → *Run workflow* on `main`, pick the inputs, run. Or from a
terminal with `gh`:

```sh
gh workflow run release.yml -f bump=patch                 # 0.1.0 → 0.1.1
gh workflow run release.yml -f bump=minor                 # 0.1.0 → 0.2.0
gh workflow run release.yml -f version=1.0.0              # an explicit version
gh workflow run release.yml -f bump=minor -f prerelease=beta.1   # 0.2.0-beta.1, marked pre-release
gh workflow run release.yml -f bump=patch -f dry_run=true # gates + the version and notes; no branch, no PR
gh run watch                                              # follow it
```

Then review and **squash-merge the release PR, keeping its title** (`gh pr merge <n> --squash`; `main` accepts
no other merge kind). The squash commit on `main` reads `chore(release): vX.Y.Z (#N)`; publish.yml runs on that
push, tags that commit and creates the Release; `gh run watch` follows it too.

| input | meaning |
|---|---|
| `bump` | `patch` (default) · `minor` · `major`, applied to the root `package.json` version; ignored when `version` is set. A bump from a prerelease finishes it (`1.0.0-beta.1` + patch → `1.0.0`). |
| `version` | an explicit `X.Y.Z`; must be after the current version |
| `prerelease` | a tag such as `beta.1`, appended as `X.Y.Z-beta.1`; the GitHub Release is marked pre-release and an npm publish goes to the `next` dist-tag |
| `dry_run` | run the gates, make the version commit on the runner, pack and smoke-test, print the version and the notes (job summary), and stop: no branch pushed, no PR. Can be dispatched from any branch; a real release refuses any branch but `main`. |

## What the release workflow does

1. Refuses a real run dispatched from a branch other than `main`.
2. Checks out with full history and tags (with `RELEASE_TOKEN` when that secret exists, below), sets up Node
   from `.nvmrc` and pnpm from `packageManager`.
3. Gates: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm test` (every package's suite
   plus `scripts/test`; the live tracker tests skip — they are opt-in by `FARSIGHT_LIVE`), `pnpm lint:strings`.
   Any failure stops the release before anything is written.
4. `node scripts/release.mjs … --no-tag --branch 'release/v{version}' --commit-notes` as `github-actions[bot]`:
   creates `release/vX.Y.Z`, bumps the root `package.json`, prepends the section to `CHANGELOG.md`, writes the
   notes to `.github/release-notes/vX.Y.Z.md` and commits all three as `chore(release): vX.Y.Z`. No tag.
5. Refuses if `release/vX.Y.Z` or the tag `vX.Y.Z` already exists on `origin`.
6. `node scripts/pack.mjs` and the smoke test: installs the tarball into a temporary npm prefix, checks that
   `farsight --version` prints the new version and the release commit, and ingests `examples/invoice-app` from a
   temporary directory.
7. Pushes `release/vX.Y.Z` and opens the PR. Its body is the release notes plus a footer saying the gates and
   the smoke test already ran on that exact commit (with a link to the run), and — when it was opened with
   `GITHUB_TOKEN` — that CI has not started yet and how to start it.

## What the publish workflow does

1. `detect`: reads the version from the root `package.json` and looks for the commit `chore(release): vX.Y.Z`
   among the pushed commits — the squash commit `chore(release): vX.Y.Z (#N)` (the expected shape, since the PR
   title becomes the subject); a merge commit bringing the branch's commit or a rebase keeping the subject would be
   found too. None → not a release, stop. Tag `vX.Y.Z` already on `origin` → nothing to do, stop (re-running is
   safe).
2. `publish`: checks out **the release commit** (the squash commit on `main`), runs the same gates, reads the notes from
   `.github/release-notes/vX.Y.Z.md`, packs, smoke-tests exactly as above, creates the annotated tag `vX.Y.Z`
   (message = the notes) on the release commit and pushes it, `gh release create vX.Y.Z
   build/farsight-cli-X.Y.Z.tgz --verify-tag` with the notes, the optional npm publish, and the job summary with
   the install line.

The squash commit is a new commit, so its sha differs from the one the release workflow smoke-tested on the
branch; publish packs again on the squash commit, and the tag, the tarball's build stamp (`farsight --version`
prints it) and the `CHANGELOG.md` section all describe that one commit on `main`. With *Require branches to be up
to date* on, as `main` has, nothing lands between the release PR and its merge unless someone updates the release
branch from `main` first — then those changes are listed in the *next* release's changelog (`<last tag>..HEAD`),
rather than shipped unlisted.

Tags are not branch pushes, so `main`'s branch protection does not stop publish from pushing `vX.Y.Z` with
`GITHUB_TOKEN`. A future **tag ruleset** would — then give the ruleset a bypass for the Actions app, or create
the tag with `gh api repos/zalos/farsight/git/refs` under a token the ruleset allows.

## CI on the release PR: GITHUB_TOKEN vs RELEASE_TOKEN

A pull request opened with the workflow's own `GITHUB_TOKEN` **does not trigger `pull_request` workflows**
(GitHub's guard against workflows triggering workflows). `main` requires `validate` and `e2e`, so such a PR
cannot merge until CI runs on it. The release workflow handles this two ways:

- **Without `RELEASE_TOKEN`** (the default): the workflow has already run the same gates plus the tarball smoke
  test on the release commit, and the PR body says so. To get the required checks, a maintainer **closes and
  reopens the PR** (`gh pr close <n> && gh pr reopen <n>`), or pushes an empty commit to the branch:
  `git fetch origin release/vX.Y.Z && git switch release/vX.Y.Z && git commit --allow-empty -m 'ci: run checks' && git push`.
  Either event comes from a person, so CI starts. (An empty commit is fine — publish still finds the release
  commit in the merge.) This path also needs *Settings → Actions → General → Workflow permissions → Allow GitHub
  Actions to create and approve pull requests* switched on; it is **off** on this repository as of 2026-10-03.
  Without it, the PR step fails after the branch is pushed, and the job summary prints the `gh pr create`
  command to open the PR by hand — a PR you open yourself starts CI.
- **With `RELEASE_TOKEN`** (recommended): a fine-grained personal access token scoped to `zalos/farsight` with
  *Contents: read and write* and *Pull requests: read and write*. Store it with
  `gh secret set RELEASE_TOKEN` (*Settings → Secrets and variables → Actions*). The workflow then checks out,
  pushes the branch and opens the PR with it, so `pull_request` fires and CI runs by itself. The token is a
  person's identity, not a bypass: it cannot push to `main` either. Give it an expiry and renew it.

publish.yml needs neither: it pushes only a tag and creates a Release with `GITHUB_TOKEN`.

## Rehearsal (the first release under protection)

1. **Dry run:** `gh workflow run release.yml -f bump=patch -f dry_run=true && gh run watch`. The summary shows
   *farsight-cli vX.Y.Z — dry run* and the notes; check `git ls-remote origin 'refs/heads/release/*'` is empty.
2. **Real run:** `gh workflow run release.yml -f bump=patch && gh run watch`, then
   `gh pr list --label release` shows `chore(release): vX.Y.Z`.
3. **CI on the PR:** with `RELEASE_TOKEN`, `gh pr checks <n> --watch`. Without it, `gh pr close <n> && gh pr
   reopen <n>` first, then `gh pr checks <n> --watch` until `validate` and `e2e` pass.
4. **Squash-merge**, keeping the PR title: `gh pr merge <n> --squash` (the branch is deleted on merge).
5. **Publish:** `gh run list --workflow publish.yml -L 1`, then `gh run watch <id>`; check
   `git fetch --tags && git show vX.Y.Z --stat` points at the `chore(release)` commit and
   `gh release view vX.Y.Z` lists `farsight-cli-X.Y.Z.tgz`.
6. **Consumer install** from a clean prefix:
   `npm install -g --prefix "$(mktemp -d)" https://github.com/zalos/farsight/releases/download/vX.Y.Z/farsight-cli-X.Y.Z.tgz`,
   then that prefix's `bin/farsight --version` prints `farsight X.Y.Z · … · commit <the release commit>`.

If publish fails after the merge (say, a flaky smoke test), fix the cause and re-run the failed run
(`gh run rerun <id> --failed`): detect still finds the release commit until the tag exists. If it must be fixed
in code, the release commit itself is broken: leave `vX.Y.Z` untagged, merge the fix by PR and cut the next
patch release — its changelog runs from the last tag, so it lists everything `vX.Y.Z` would have.

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

The workflows are thin shells around two zero-dependency scripts, both usable locally:

```sh
node scripts/changelog.mjs --dry-run                 # the next section and release notes, from <last tag>..HEAD
node scripts/release.mjs --dry-run --bump patch      # what a release would do, and what would stop it
node scripts/release.mjs --bump patch --no-tag --branch 'release/v{version}' --commit-notes
                                                     # the release workflow's step, by hand: a release branch, no tag
git push -u origin release/vX.Y.Z && gh pr create --base main --title 'chore(release): vX.Y.Z' --body-file .github/release-notes/vX.Y.Z.md --label release
```

A release opened by hand like this is the same release PR: squash-merge it and publish.yml tags and publishes.
A PR you open yourself starts CI, so this is also the fallback when the workflow cannot open the PR.

`node scripts/release.mjs --bump patch` without `--no-tag` still commits **and tags** on the current branch,
as before; under protection that tag cannot reach `main`'s history by a push, so use it only to rehearse locally
(then delete the branch and the tag).

- `changelog.mjs` groups conventional-commit subjects (`type(scope)!: subject`, `BREAKING CHANGE:` footers)
  under *Breaking · Features · Fixes · Performance · Docs · Tests · Chores · Other*; merge commits and earlier release
  commits are skipped; a subject that is not a conventional commit lands under *Other*. Since PRs are
  squash-merged, each commit on `main` is one PR: the ` (#N)` GitHub appends to the subject is dropped from the
  line and printed as a link to the PR, which is why the **PR title must be a conventional commit** (CI's `commits`
  check holds that). Flags: `--version`, `--since <tag|sha>`, `--write` (prepends to `CHANGELOG.md` below an
  `## [Unreleased]` head), `--notes <file>`, `--dry-run`. Before the first tag the range starts after the commit
  that seeded `CHANGELOG.md`'s newest section (history: releases before 2026-10-04 were merged with merge commits).
- `release.mjs` refuses a dirty tree, a branch other than `main` (without `--allow-branch`), a tag that exists,
  a `--branch` that exists, and a version that does not move forward. Only the root `package.json` version
  moves: `pack.mjs` gives it to the tarball and core's `buildInfo()` reads it in a workspace build; `packages/*`
  keep their private workspace versions. `--no-tag` commits without tagging; `--branch <name>` creates and
  switches to that branch first (`{version}` and `{tag}` are filled in); `--commit-notes` writes the notes to
  `.github/release-notes/vX.Y.Z.md` and commits them, which is where publish.yml reads them;
  `--trailer "Key: value"` adds a commit trailer.

## Publishing to npm (optional, later)

publish.yml already has the step; it prints *npm publish skipped: no NPM_TOKEN* until a token exists.

1. On npmjs.com, create an account (or organization) that can own the `farsight-cli` name, then an
   **automation** access token (or a granular token with publish rights on `farsight-cli`).
2. In the GitHub repository: *Settings → Secrets and variables → Actions → New repository secret*, name
   `NPM_TOKEN`, paste the token. From a terminal: `gh secret set NPM_TOKEN`.
3. The next release publishes `build/farsight-cli-X.Y.Z.tgz` with `--access public --provenance` (publish.yml has
   `id-token: write`, and the packed `package.json` names the repository, which provenance requires), on the
   `latest` dist-tag, or `next` for a prerelease. Consumers can then `npm install -g farsight-cli`.
