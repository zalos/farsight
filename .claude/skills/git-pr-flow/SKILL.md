---
name: git-pr-flow
description: How a change reaches Farsight's main — a branch, Conventional Commits along the way, a pull request whose title is the one commit that lands (PRs are squash-merged; title = subject, body = message), CI's four required checks (validate · e2e · secrets · commits), and `gh pr merge --squash`. Loads when committing, writing a PR title or body, merging a PR, opening a release PR, or when a merge or a check is refused.
allowed-tools: Bash Read Grep
---

# Branch → conventional commits → PR → squash merge

`main` is protected and takes pull requests only; since 2026-10-04 it accepts **only squash merges**. One PR becomes
one commit on `main`, whose **subject is the PR title** and whose **message is the PR body**. That commit is also the
line `scripts/changelog.mjs` prints in `CHANGELOG.md` and the release notes. Everything below follows from that.

## The flow

```sh
git switch -c feat/<what>                       # feat/ fix/ docs/ chore/ — never work on main
# … commit as you go: type(scope): what changed — the commit-msg hook checks the shape
pnpm build && pnpm typecheck && pnpm -r test && pnpm lint:strings && pnpm e2e   # exactly what CI runs
pnpm lint:commits --message 'feat(server): the title you will give the PR'      # the title is the commit
git push -u origin HEAD
gh pr create --base main --title 'feat(server): …' --body-file <body.md>        # body = .github/PULL_REQUEST_TEMPLATE.md
gh pr checks <n> --watch                        # validate · e2e · secrets · commits, all required
gh pr merge <n> --squash                        # keep the PR title; the branch is deleted on merge
```

## The title (the rule CI's `commits` job enforces)

`type(scope): what changed` — lower-case type, one space after the colon, no full stop, under 120 characters.

- **types:** `feat fix docs test chore build ci refactor perf style revert`
- **scopes:** a package — `core parsers server mcp cli work work-jira work-azdo work-fixture` — or a surface — `e2e
  scripts ci docs proposals examples release deps viewer skills`. A new scope goes into `SCOPES` in
  `scripts/lint-commits.mjs` in the same PR.
- `!` after the scope, or a `BREAKING CHANGE:` footer in the body, marks a breaking change (the changelog's *Breaking*).
- Write it for the reader of the changelog: what changed, in words (`fix(server): the picker waits for its document`),
  not how (`fix(server): add null check`).

The PR body follows the template: **what changed · why · how it was checked · left open**. It becomes the commit
message, so it is for someone reading `git log` later, not only the reviewer. No session links, no client names, no
private paths (the repo is public); `Co-Authored-By:` lines are fine.

## Commits on the branch

Conventional too (the `commit-msg` hook `pnpm install` installs runs `scripts/lint-commits.mjs --file … --any-scope`;
CI runs the same over `base..head`), but they are **working notes**: commit often, stage by path (never `git add -A`),
and do not rewrite or polish them — the squash folds them. A `Merge main into …` commit from `git merge main` is
skipped by the lint. Never `git stash` (one stash stack serves every worktree; two agents' pops crossed once).

## Release PRs

`gh workflow run release.yml -f bump=patch|minor|major` opens `chore(release): vX.Y.Z` from `release/vX.Y.Z`. It is
squash-merged like any PR, keeping that title; the squash commit `chore(release): vX.Y.Z (#N)` is what
`publish.yml` tags and packs. Details and the `RELEASE_TOKEN` note: `docs/RELEASING.md`.

## When something is refused

| refusal | what it means | do |
|---|---|---|
| `commits` check red on the title | the type or scope is not on the list, or the shape is off | `gh pr edit <n> --title '…'`; the check re-runs |
| `commits` check red on a branch commit | a commit has no conventional shape | the tip: `git commit --amend -m '…'`; an older one: reword it with a non-interactive rebase (`GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick <sha>/reword <sha>/'" git rebase -i <base>`), then force-push *your branch*, never `main` |
| merge refused, "not up to date" / "add --admin" | the branch is behind `main`, not a failed check | `gh pr update-branch <n>`, `gh pr checks <n> --watch`, merge again — **never `--admin`** |
| `gh pr merge --merge` or `--rebase` refused | `main` allows squash only | `--squash` |
| the hook rejects a local commit | the subject is not conventional | fix the message; `.gitmessage` shows the shape |
| CI did not start on a release PR | opened with `GITHUB_TOKEN` | `gh pr close <n> && gh pr reopen <n>`, or add `RELEASE_TOKEN` |

After the merge, the lead's ritual (build, pack, reinstall under both Node prefixes, restart the servers by port,
re-sync) is in the project memory and `AGENTS.md` § Gotchas; it is not part of this skill.
