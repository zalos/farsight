# Farsight Echo

Echo is the optional memory companion for Farsight. This package establishes local setup, isolated profiles, an agentmemory connection, an Ollama connection, and a settings view. It runs independently of Farsight.

**This is a foundation release.** Hooks can bind a session to a profile, but automatic capture, relevant memory briefs, detail tools, and skill discovery are not implemented yet.

From the repository, use Node 24 and pnpm 9:

```sh
pnpm install
pnpm build
node packages/echo/dist/cli.js setup
node packages/echo/dist/cli.js serve
```

Setup asks about preparing Claude Code and Codex hooks. Package installation never prompts or enables host hooks. The settings view runs on the loopback address printed by `serve`.

Build the separately installable package with `pnpm pack:echo`. Install its generated `build/echo/farsight-echo-<version>.tgz` tarball to use the `farsight-echo` command. Packaging does not publish a release.

See [Echo setup and boundaries](../../docs/ECHO.md) for profile isolation, storage, optional hook activation, and the synthetic verification command.
