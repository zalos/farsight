<!--
The title is the commit: PRs are squash-merged and the title becomes the one commit on main and the
line in CHANGELOG.md. Write it as a Conventional Commit — `type(scope): what changed`, e.g.
`feat(server): a searchable project picker` (types and scopes: CONTRIBUTING.md). The body below becomes
that commit's message, so write it for someone reading `git log` next year, not for the reviewer today.
Validate the exact title with pnpm lint:commits --message '…' before opening/updating the PR and before merge.
Keep the title as the squash-commit subject; branch commit subjects need not be identical.
Discussion/review comments use Conventional Comments: label (blocking|non-blocking): subject, with context below.
The PR description itself keeps the sections below. See AGENTS.md for the shared Codex/Claude rules.
-->

## What changed

<!-- one or two sentences in words a reader of the changelog understands; a list if it is several things -->

## Why

<!-- the need or the defect, with the proposal or finding it answers when there is one -->

## How it was checked

<!-- actual checks appropriate to the affected work (docs/CI.md), screenshots inspected or measured outcomes;
     ordinary Markdown changes need no runtime tests; do not imply an older run checked a newer commit -->

## Left open

<!-- what this PR does not do that a reader might expect; "nothing" is a fine answer -->
