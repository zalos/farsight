# Release workflow and affected CI checks

Archived from `docs/AI-HANDOFF.md` on 2026-10-28 (2026-10-01 → 10-17). Dated records, verbatim apart from
re-pointed relative links; read on demand, never loaded at session start. Index: [README.md](README.md).

## Affected CI checks — 2026-10-17

Follow-up on the same branch: Codex and Claude must use Conventional Commits, Conventional Comments for PR/review
feedback, and a validated PR title preserved as the squash-commit subject. `AGENTS.md` is the canonical project
rule, imported by `CLAUDE.md`; the PR template reinforces it. Both providers' global instructions and shared memory
also record the user's preference. Scope remains optional, matching the spec; guidance is deliberately concise. PR #114's title is
`ci: run only checks affected by changed paths`.

Branch `codex/ci-affected-checks` adds a small path selector for validation, e2e and Echo packaging. Ordinary
Markdown changes skip runtime checks; packaged Echo docs still check packaging, and fixture Markdown remains
test input. Unit-test-only and e2e-only edits select their respective suites; shared and unknown inputs run all
checks. Secret scanning and commit conventions remain independent. PR title edits rerun the separate commit
workflow without cancelling tests. Publish detection no longer fetches LFS assets.

Local checks: `pnpm test:scripts` (19 passed), `actionlint` on the changed workflows, and `git diff --check`.
Replaying the docs-only `09bbb8f` push selects no runtime checks. Regression coverage includes PR merge-bases,
multi-commit pushes, deletions, renames into docs, unusual filenames and unavailable ranges. The workflow changes
themselves select the full checks on GitHub; individual test selection is deliberately out of scope. No runtime
build, deployment or live-server refresh is needed for this CI-only change. See `docs/CI.md` for the selection table
and local validation guidance.

The initial implementation at `f77fe86` passed all GitHub checks, including e2e and Echo packaging. A live PR-title
edit reran only commit conventions and left the original CI run uninterrupted. The subsequent instruction-only
follow-up is checked with the commit/title linter and `git diff --check`; the PR's cumulative workflow changes
still select the full CI checks on GitHub.

## Release and CI — 2026-10-01

- **Releases are on demand.** `gh workflow run release.yml -f bump=patch|minor|major` (or the Actions tab; `-f dry_run=true`
  rehearses) runs the gates, bumps the root version, writes `CHANGELOG.md` and the release notes from conventional
  commits (`scripts/changelog.mjs`), commits `chore(release): vX.Y.Z` as `github-actions[bot]`, tags, packs, smoke-tests
  the tarball (`--version` must print the release commit; an ingest must succeed), pushes, and publishes a GitHub Release
  with `farsight-cli-X.Y.Z.tgz`. npm publish runs only when an `NPM_TOKEN` secret exists. → `docs/RELEASING.md`.
  **v0.1.1** is the first release (2026-10-01); a consumer install from the release URL into a clean prefix printed
  `farsight 0.1.1 · commit 00b18dd` and ingested the invoice-app example (87 nodes). (Until 2026-10-04 PRs were
  merged with merge commits so the changelog could walk every commit; since then PRs are squash-merged, below.)
- **Since 2026-10-03 a release is a release PR** (`main` is protected, no bypass): `release.yml` opens
  `chore(release): vX.Y.Z` from `release/vX.Y.Z` (version commit + `CHANGELOG.md` + `.github/release-notes/vX.Y.Z.md`,
  gates and smoke test already run); merging it runs `publish.yml`, which tags the release commit, packs, smoke-tests
  and creates the GitHub Release. A PR opened with `GITHUB_TOKEN` does not start CI — close/reopen it, or add a
  `RELEASE_TOKEN` PAT (`docs/RELEASING.md`). **Rehearsed for real with v0.2.0 (2026-10-04):** the workflow's gates and smoke test passed, PR #36 opened, its CI did
  not start (no `RELEASE_TOKEN`), a close/reopen started it, a merge commit merged it, publish.yml tagged `v0.2.0` and
  published the Release with `farsight-cli-0.2.0.tgz`. Add a `RELEASE_TOKEN` PAT to drop the close/reopen step.
- **Since 2026-10-04 PRs are squash-merged and the convention is enforced** (PR #38). `main` accepts only squash
  merges — GitHub settings: merge commits and rebase merges off, squash title = PR title, squash message = PR body,
  linear history required, branches deleted on merge — so one PR is one commit on `main` and one changelog line. The
  PR title must be a Conventional Commit and the body follows `.github/PULL_REQUEST_TEMPLATE.md` (*what changed · why ·
  how it was checked · left open*). CI's fourth job, **`commits`** (required), lints the PR title against the type and
  scope lists and every branch commit for shape (`scripts/lint-commits.mjs`, `pnpm lint:commits`); `pnpm install`
  installs the same lint as a `commit-msg` hook and sets `.gitmessage` as the commit template (`scripts/install-hooks.mjs`
  copies into `.git/hooks`; the LFS hooks stay). `changelog.mjs` turns a squash subject's ` (#N)` into a PR link;
  publish.yml finds the release commit as `chore(release): vX.Y.Z (#N)` and tags the squash commit. The lead merges with
  `gh pr merge <n> --squash`, keeping the title — the project skill `.claude/skills/git-pr-flow` carries the flow.
- **CI on every push and PR** (`ci.yml`): validate (install, build, typecheck, tests, string lint, ~1 min) and e2e
  (Playwright chromium, 109 specs, ~1.5 min) in parallel on Ubuntu; artifacts on failure; the live tracker tests skip
  there. First run on `main` green. → `docs/CI.md`. Watch: `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19.
