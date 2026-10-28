# History — dated records, read on demand

`docs/AI-HANDOFF.md` holds only the work in flight and is loaded at every session start. Everything dated —
validation runs, real-ingest measurements, review findings, swarm scores, what each pass left open — lives here,
one file per area, newest first. Nothing here is imported; open the file the task needs.

| file | covers | open it when |
|---|---|---|
| [sentinel-v2.md](sentinel-v2.md) | 2026-10-23 → 10-28: the v2 proposal, phase 0 (Prettier, ESLint, lefthook, frozen suppressions, intermittent CI tests), the thin slice and the demo build | working on Sentinel v2, a lint suppression or a phase-0 flake |
| [sentinel-v1.md](sentinel-v1.md) | 2026-10-17 → 10-23: the Sentinel proposal, PRs 00–30 as built, scanner packs, framework libraries, owner reports, MCP controls, native isolation, the closeout | tracing why a Sentinel v1 boundary exists or what a PR measured |
| [parsers-and-cli.md](parsers-and-cli.md) | 2026-10-17 → 10-21: the parser library extraction (#115), NestJS routes (#119), declared paths, the API delivery policy and vocabulary, test evidence imports, packaging prerequisites | touching `@farsight/graph`, `@farsight/code-parser`, NestJS or API reconciliation |
| [echo.md](echo.md) | 2026-10-13 → 10-17: Echo's sub-mind, model setup and prompt research, PR #104's review | touching `packages/echo` |
| [tooling-and-ci.md](tooling-and-ci.md) | 2026-10-01 → 10-17: the release workflow and release PRs, squash-merge enforcement, affected CI checks | changing a workflow or a release |
| [viewer-passes.md](viewer-passes.md) | 2026-09-21 → 10-14: the clarity phase through the outsider fix round (items 1–20), the 2026-10-10 state, the swarm findings and the left-open lists, the documentation-as-source direction | working on the viewer, MCP or CLI surfaces, or planning the next Farsight round |

Durable setup (runtime, provider access, live tracker tests, credential naming) is in [../AI-SETUP.md](../AI-SETUP.md).
Older history, review evidence and client material stay in the owner's private folder, outside this public repo.

**Adding a record:** when work lands, put its dated detail at the top of the matching file (a new file for a new
area, with a row above) and leave one line in the handoff, or none once it no longer shapes what is next.
