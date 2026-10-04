<!--
The title is the commit: PRs are squash-merged and the title becomes the one commit on main and the
line in CHANGELOG.md. Write it as a Conventional Commit — `type(scope): what changed`, e.g.
`feat(server): a searchable project picker` (types and scopes: CONTRIBUTING.md). The body below becomes
that commit's message, so write it for someone reading `git log` next year, not for the reviewer today.
-->

## What changed

<!-- one or two sentences in words a reader of the changelog understands; a list if it is several things -->

## Why

<!-- the need or the defect, with the proposal or finding it answers when there is one -->

## How it was checked

<!-- what was run or looked at: `pnpm build && pnpm typecheck && pnpm -r test && pnpm lint:strings && pnpm e2e`,
     the screenshot that was looked at, the measurement on the reference app (counts, zero page errors) -->

## Left open

<!-- what this PR does not do that a reader might expect; "nothing" is a fine answer -->
