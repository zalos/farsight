# Releasing farsight-cli and farsight-sentinel

A release is a version commit `chore(release): vX.Y.Z`, an annotated tag `vX.Y.Z` on that commit, a
`CHANGELOG.md` section and a GitHub Release carrying two independently versioned, installable tarballs:
`farsight-cli-X.Y.Z.tgz` (its version is the tag's) and `farsight-sentinel-A.B.C.tgz` (its own version, named
explicitly for every release and never derived from farsight-cli's), plus `release-manifest.json`, which names
each package's version, file, URL, size and SHA-256. Each installs on its own with only Node and npm.

`main` is protected: no direct pushes, pull requests only, the `validate` and `e2e` checks required, enforced
for admins and for the Actions token. So a release goes through a **release PR**, in two workflows:

| workflow | trigger | permissions | what it does |
|---|---|---|---|
| **release** (`.github/workflows/release.yml`) | `workflow_dispatch`, from `main` | `contents: write` (pushes `release/vX.Y.Z`, never `main`) · `pull-requests: write` | gates → version commit on a new branch `release/vX.Y.Z` → pack + smoke test → push the branch → open the PR `chore(release): vX.Y.Z` labelled `release`, the release notes as its body |
| **publish** (`.github/workflows/publish.yml`) | every `push` to `main`; does real work only when the push brings in `chore(release): vX.Y.Z` for the version `package.json` now carries | `contents: write` (tag + Release) · `id-token: write` (npm provenance) | gates → pack both + smoke test + npm-only acceptance → annotated tag `vX.Y.Z` on the release commit → GitHub Release with both tarballs and `release-manifest.json` → npm for farsight-cli (optional) → verify-release |
| **verify-release** (`.github/workflows/verify-release.yml`) | called by publish; `workflow_dispatch` with a tag, any time | `contents: read` | reads the published `release-manifest.json`, checks each tarball's size and digest, installs the published URLs in clean npm-only consumers |

Nothing releases on an ordinary push: publish's `detect` job finds no release commit and stops in seconds.

## Cut a release

From the repository's **Actions** tab: *release* → *Run workflow* on `main`, pick the inputs, run. Or from a
terminal with `gh`:

```sh
gh workflow run release.yml -f bump=patch -f sentinel_version=0.1.0   # farsight-cli 0.1.0 → 0.1.1, farsight-sentinel at 0.1.0
gh workflow run release.yml -f bump=patch                 # 0.1.0 → 0.1.1 (refused while packages/sentinel exists: name its version)
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
| `sentinel_version` | farsight-sentinel's own release version `A.B.C`; **required** while the checkout has `packages/sentinel`, must be after Sentinel's current version, and is never taken from farsight-cli's. It is written to `packages/sentinel/package.json` and the release manifest. |
| `prerelease` | a tag such as `beta.1`, appended as `X.Y.Z-beta.1`; the GitHub Release is marked pre-release and an npm publish goes to the `next` dist-tag |
| `dry_run` | run the gates, make the version commit on the runner, pack and smoke-test, run the acceptance (pending gates reported, not blocking — the only place they may be), print the version and the notes (job summary), and stop: no branch pushed, no PR, no tag. Can be dispatched from any branch; a real release refuses any branch but `main`. |

## What the release workflow does

1. Refuses a real run dispatched from a branch other than `main`.
2. Checks out with full history and tags (with `RELEASE_TOKEN` when that secret exists, below), sets up Node
   from `.nvmrc` and pnpm from `packageManager`.
3. Gates: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm test` (every package's suite
   plus `scripts/test`; the live tracker tests skip — they are opt-in by `FARSIGHT_LIVE`), `pnpm lint:strings`.
   Any failure stops the release before anything is written.
4. `node scripts/release.mjs … --sentinel-version A.B.C --no-tag --branch 'release/v{version}' --commit-notes` as
   `github-actions[bot]`: creates `release/vX.Y.Z`, bumps the root `package.json` and `packages/sentinel/package.json`
   (each to its own version), prepends the section to `CHANGELOG.md`, writes the notes (with one install line per
   package) to `.github/release-notes/vX.Y.Z.md` and the release manifest to `.github/release-manifests/vX.Y.Z.json`,
   and commits them as `chore(release): vX.Y.Z`. No tag.
5. Refuses if `release/vX.Y.Z` or the tag `vX.Y.Z` already exists on `origin`.
6. `node scripts/pack.mjs`, and `node scripts/pack-sentinel.mjs --expect-version A.B.C` (the manifest's version;
   any other is refused), then the smoke test: installs farsight-cli into a temporary npm prefix, checks that
   `farsight --version` prints the new version and the release commit, and ingests `examples/invoice-app` from a
   temporary directory. Then the [npm-only acceptance](#the-npm-only-acceptance) of both tarballs.
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
   `.github/release-notes/vX.Y.Z.md`, validates `.github/release-manifests/vX.Y.Z.json` against both packages'
   own manifests, packs both, smoke-tests and runs the npm-only acceptance exactly as above, writes
   `release-manifest.json` (each tarball's URL, size and SHA-256), creates the annotated tag `vX.Y.Z` (message =
   the notes) on the release commit and pushes it, `gh release create vX.Y.Z release-manifest.json
   build/farsight-cli-X.Y.Z.tgz build/sentinel/farsight-sentinel-A.B.C.tgz --verify-tag` with the notes, the
   optional npm publish of farsight-cli, and the job summary with one install line per package, read from the
   uploaded manifest.
3. `verify`: [verify-release](#verify-a-published-release) on the new tag.

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

## The npm-only acceptance

`scripts/npm-acceptance.mjs` is one runner for every place a tarball is checked: CI's `sentinel-package` job (the
freshly packed tarballs), the release and publish workflows, and verify-release (the published URLs). Local files are
served over a loopback URL, so npm installs and locks a URL exactly as it would a release asset. Six consumers:
farsight-cli alone, farsight-sentinel alone and both, each with a global `--prefix` and in a project. Each has a
toolchain of exactly `node`, `npm` and `npx` (no pnpm, corepack, yarn or other global bins on `PATH`), no inherited
npm configuration or `NODE_PATH`, its own `HOME`, and no way to resolve a workspace package.

| gate | what it shows |
|---|---|
| `consumer.*` | only node/npm/npx reachable; installed bytes are the verified bytes (below); no `@farsight/*` workspace package, pnpm or corepack; only the chosen packages present; in a project, the lockfile records each URL with the verified integrity and `npm ci` reinstalls the same packages |
| `farsight.*` | `--version` with the version and commit; `farsight.config.json` → ingest twice, the config unchanged and applied; read-only `serve` answers `/api/version`; `farsight mcp` answers an MCP stdio handshake |
| `sentinel.*` | `--version` with Sentinel's own version (never farsight-cli's); `--help`; `capabilities --json`; `dist/build-stamp.json` names the version and commit; a store is created and reopened under a new epoch |
| `combined.uninstall-sentinel-keeps-data-and-farsight` | uninstalling farsight-sentinel leaves its store byte for byte and farsight-cli working; a reinstalled Sentinel reopens the store |
| pending until built | `sentinel.init-twice-preserves-config`, `sentinel.adopt-plan-run`, `sentinel.interrupt-resume` (PR 09); `sentinel.report-offline`, `sentinel.compare` (PR 19); `sentinel.replay` (PR 26); `sentinel.mcp-handshake` (PR 23a); `combined.host-handshake` (PR 24) |

**What is installed is what was verified.** Each tarball is held as one verified copy with its SHA-256 and SHA-512
(verify-release passes the copies it checked against the release manifest; a URL given to the runner alone is
downloaded once). A global install installs that copy. A project install names the URL in `package.json`, pins the
verified SHA-512 in `package-lock.json` (generated from the copy under a separate npm cache), and `npm ci` fetches
the URL itself; npm refuses different bytes with `EINTEGRITY` before any install script runs. A server that answers a
later request with another tarball fails the verification and runs nothing (`scripts/test/verify-release.test.mjs`).

A pending gate is never reported as passed. Each names the capability the installed Sentinel reports for it; when
the package reports that capability available, the gate **fails** until its check is written in the runner, so a
release cannot claim a feature nothing verified. Exit 0 only when every gate passed, 1 when a gate failed, 2 when a
gate is pending.

**Publication cannot skip a gate.** A real release-workflow run, publish.yml (whatever commit triggers it) and
verify-release all require every gate passed; there is no input, variable or flag that waives one, and publish runs
the acceptance before it tags, creates the Release, uploads or publishes to npm. `--allow-pending` exists only for
checks that publish nothing: CI's `sentinel-package` job and a release **dry run** (no branch, no PR, no tag). A
static test (`scripts/test/release-workflows.test.mjs`) holds the workflows to this.

```sh
pnpm pack:cli && pnpm pack:sentinel
node scripts/npm-acceptance.mjs --farsight build/farsight-cli-X.Y.Z.tgz --sentinel build/sentinel/farsight-sentinel-A.B.C.tgz \
  --expect-farsight X.Y.Z --expect-sentinel A.B.C [--expect-commit <sha>] [--only farsight|sentinel|both] [--modes global,local] \
  [--allow-pending] [--report acceptance.json]     # --allow-pending: a development check only
```

## Verify a published release

```sh
gh workflow run verify-release.yml -f tag=vX.Y.Z      # in Actions: Node and npm only, no pnpm, no build
node scripts/verify-release.mjs --tag vX.Y.Z         # locally; any machine with Node 24 and npm
```

It reads `https://github.com/zalos/farsight/releases/download/vX.Y.Z/release-manifest.json`, downloads each tarball
from the URL the manifest names for it and checks its size and SHA-256, then runs the acceptance on those URLs; a
pending gate fails it like a failed one (`--diagnostic` reports pending gates locally and says it is not a
verification; no workflow passes it). It changes nothing and can be re-run at any time; it does not depend on publish.yml running again (a re-run of publish
skips a tag that exists).

If publish fails after the merge (say, a flaky smoke test), fix the cause and re-run the failed run
(`gh run rerun <id> --failed`): detect still finds the release commit until the tag exists. If it must be fixed
in code, the release commit itself is broken: leave `vX.Y.Z` untagged, merge the fix by PR and cut the next
patch release — its changelog runs from the last tag, so it lists everything `vX.Y.Z` would have.

## Install a release (consumers)

Each Release's notes carry one line per package, each from that package's own version; for a release `vX.Y.Z`
carrying farsight-sentinel `A.B.C`:

```sh
npm install -g https://github.com/zalos/farsight/releases/download/vX.Y.Z/farsight-cli-X.Y.Z.tgz
farsight --version   # farsight X.Y.Z · built <time> · commit <sha> · packed
# optional, installed separately:
npm install -g https://github.com/zalos/farsight/releases/download/vX.Y.Z/farsight-sentinel-A.B.C.tgz
farsight-sentinel --version
```

Releases before Sentinel was published carry farsight-cli alone.

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
  a `--branch` that exists, and a version that does not move forward. The root `package.json` version moves:
  `pack.mjs` gives it to the tarball and core's `buildInfo()` reads it in a workspace build. While
  `packages/sentinel` exists, `--sentinel-version A.B.C` is required (after Sentinel's current version) and moves
  `packages/sentinel/package.json`, which `pack-sentinel.mjs` packs from; it is refused without that package. The
  other `packages/*` keep their private workspace versions. Both versions go into
  `.github/release-manifests/vX.Y.Z.json`; `node scripts/release-manifest.mjs validate --tag vX.Y.Z` checks it
  against the packages. `--no-tag` commits without tagging; `--branch <name>` creates and
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

farsight-sentinel is not published to a registry: its manifest is `private`, so npm refuses to publish it. Its
GitHub Release tarball installs with npm all the same. Registry publication for it is a separate decision.

## Install a selected release in CI

Each published GitHub Release carries `farsight-cli-X.Y.Z.tgz` (and, from the first release that ships it,
`farsight-sentinel-A.B.C.tgz`). A CI job can install a pinned release directly:

```sh
npm install -g https://github.com/zalos/farsight/releases/download/v0.3.0/farsight-cli-0.3.0.tgz
farsight --version
```

Choose the release containing the fixes the job requires; a tarball reflects its release commit, not later
commits on `main`. To package a checkout instead, run `pnpm install --frozen-lockfile`, then
`pnpm build && node scripts/pack.mjs`. Packaging without the compiled packages prints that prerequisite.

A running MCP process keeps the build it started with. Reconnect it after installing another build.
`graph_overview` reports build identity, and `refresh_graph` re-ingests the recorded sources and reloads the graph; refreshing the graph does
not replace the running process's compiled code.
