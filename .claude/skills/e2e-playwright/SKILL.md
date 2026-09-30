---
name: e2e-playwright
description: Farsight's Playwright e2e suite — the real `farsight serve` on a fixture graph (a temp copy of examples/invoice-app, port 4510), the MCP data-flow spec over stdio (port 4511 for its /api/sync check), page.route fault injection (no MSW, ADR 8), the pageErrors auto-fixture, `pnpm e2e` and how its stamped results.json reaches the dogfood graph as e2e tests with last run and freshness. Plus generic Playwright references (locators, assertions, auto-waiting, traces, anti-patterns). Auto-loads when working on e2e/*.pw.spec.ts or e2e/playwright.config.ts.
allowed-tools: Read Glob Grep Bash
---

# Playwright e2e for Farsight

Farsight's e2e suite drives the **real** built product: the real CLI ingests a fixture, the real server
serves the real viewer, the real MCP server answers an MCP SDK client. Nothing between the browser and the
server is mocked except, per test, the faults a real fixture cannot produce on demand. Why: ADR 8 in
[docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) (no MSW — the viewer is un-bundled ES modules, and
nearly everything it shows is a fold the server computes; a mock would test it against hand-kept copies of
core's output).

## Layout

| path | what it is |
|---|---|
| `e2e/playwright.config.ts` | two projects: `viewer` (chromium, 1440×900, baseURL `http://localhost:4510`) and `mcp` (no browser); `list` + `html` + `json` reporters; trace on first retry; `reuseExistingServer: false` |
| `e2e/fixture/workspace.mjs` | `makeWorkspace(label)` — `mkdtemp` → copies `examples/invoice-app`, writes `.farsight/settings.json` naming it the one local source, runs `farsight ingest --out <tmp>/graph.json` **from the temp cwd** (snapshots are cwd-relative) |
| `e2e/fixture/serve.mjs` | the webServer command: `makeWorkspace` then `farsight serve` with cwd = the workspace, so `/api/sync` re-ingests the copy, never this repo |
| `e2e/tests/support.ts` | `test` with the auto `pageErrors` fixture, `gotoReady(page, hash)`, `openBillingCycle(page)` |
| `e2e/tests/*.pw.spec.ts` | the specs (front door, lens, fast travel, journey views, journey chrome, tests surface, escape/focus, faults, stories, mcp) |
| `e2e/test-results/results.json` | the json report — **read by the dogfood graph** (gitignored) |
| `e2e/.playwright-report/` | the html report; a dot-dir on purpose — the source walk skips dot-dirs, and the trace viewer ships JS that would otherwise be ingested as Farsight functions |
| `scripts/e2e.mjs` | `pnpm e2e`: runs Playwright, then stamps the content digest into results.json |

The fixture is `examples/invoice-app` (85 nodes: 3 flows from a screens manifest, 7 routes, vitest + playwright
reports). Specs rely on its facts — `Billing cycle` is the start-here flow with 3 screens, `computeTax` is at
`src/server/taxEngine.ts:9`. Change the example and these assertions move with it.

## Commands

```sh
# with a Node 24 on PATH (nvm use)
pnpm build                                    # the suite drives packages/*/dist — build first, always
pnpm e2e                                      # whole suite + digest stamp
pnpm e2e --project=mcp                        # just the MCP data-flow spec
pnpm e2e e2e/tests/journey.pw.spec.ts -g "view switch"
pnpm e2e:typecheck                            # tsc over e2e/ (also part of the root `pnpm typecheck`)
npx playwright show-report e2e/.playwright-report
node .claude/skills/e2e-playwright/scripts/check-e2e-setup.mjs   # doctor: build, browser, ports, report
```

Do **not** pass `--reporter=…` to `pnpm e2e`: a CLI reporter replaces the config's, the json report is not
written, and the stamp lands on the previous run's file. The browser is the cached `chromium-1234` that
`@playwright/test@1.62.1` expects (the pinned root devDependency); `npx playwright install chromium` only if missing.

## Ports and servers

- **4510** is the viewer suite's webServer, **4511** the MCP spec's own `farsight serve` (checked free first;
  it fails loudly otherwise). **4477 / 4478 are the lead's live servers — never touch them.**
- Two lanes running the suite at once: `FARSIGHT_E2E_PORT=45xx FARSIGHT_E2E_SYNC_PORT=45yy pnpm e2e` moves both
  ports (defaults 4510 / 4511); `e2e/playwright.config.ts` and `mcp.pw.spec.ts` read them.
- **4539** is the fake Storybook `stories.pw.spec.ts` serves itself (a node `http` server: `/index.json` +
  `/iframe.html`) — the server reads a Storybook's index server-side, so `page.route` cannot stand in for it.
  `FARSIGHT_E2E_SB_PORT` moves it; `fixture/workspace.mjs` points the fixture source's `storybook.url` there.
- `reuseExistingServer` is off: an occupied 4510 fails the run instead of silently testing someone else's
  server (AGENTS.md: *a negative result may be someone else's server*).
- Stop a stray server by port or pid (`lsof -nP -iTCP:4510 -sTCP:LISTEN`, then `kill <pid>`), **never**
  `pkill -f "cli.js serve"` — that kills the lead's servers too.
- The global `farsight` bundles its own viewer; the suite always runs `packages/cli/dist/cli.js`.

## Writing a spec

- Import `test`/`expect` from `./support`, not `@playwright/test` (the MCP spec is the exception — no page).
  `pageErrors` then fails the test on any `pageerror`, console error, or HTTP ≥ 400 it did not declare.
  A spec that injects a failure declares it: `test.use({ expectedHttpErrors: [/\/api\/tests\?/] })`.
  One known noise is allow-listed in `support.ts` with its reason (a design screen with a Figma node but no
  image asks `/api/design/image` → 404 without `FIGMA_TOKEN`); do not widen that list to get a test green.
- Start with `gotoReady(page, '#/route')` — it waits for the status bar to leave `loading…`, i.e. for the
  keymap listener. A `⌘K` pressed before that is lost silently.
- Locators: roles and labels first (`getByRole('dialog', { name: 'Journey', exact: true })` — `exact`, because
  `Forks along this journey` is also a dialog), ids only where the viewer offers nothing better (`#jrn-title`,
  `#tst-body`). Web-first assertions (`toHaveURL`, `toHaveClass`, `toHaveCSS`), never `waitForTimeout`.
- Real pointer clicks. Never `force: true` or `dispatchEvent` to get past something that swallows a click —
  that is the bug. `journey-chrome.pw.spec.ts` fails today for exactly that reason (the top bar is `inert`
  behind an open journey; Playwright reports `<body> intercepts pointer events`) and is deliberately not
  `test.fixme`: it goes green when the fix lands.
- At 1440 the top bar overflows: `fitTopbar` moves the register toggle (and others) into the `⋯` menu —
  open `#morebtn` first when `#morewrap` is visible.
- **Link each test to what it covers** with `@covers` in a JSDoc above the `test(...)`, one value per line:
  a qualified name `packages/server/public/app/shell.js::setLens`, a route `GET /api/tests`, or a full node id.
  Farsight ingests these as *declared* edges; `request.get('/x')` / `page.goto('/x')` literals add *static*
  ones where the graph has a route/page for that path. A claim that resolves to nothing becomes an orphan in
  `farsight tests list` — fix it, don't leave it. Fixture nodes (`invoice-app::…`) are not in the dogfood
  `farsight` source and cannot be claimed.

## Faults: `page.route`, per test

```ts
await page.route('**/api/tests?*', (r) => r.fulfill({ status: 500, json: { error: 'injected by e2e' } }));
await page.route('**/api/version', async (r) => {                // modify a real response
  const res = await r.fetch(); const v = await res.json();
  v.install = { ...v.install, newerInstalled: true };
  await r.fulfill({ response: res, json: v });
});
await page.route('**/api/journey?*', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
await page.unroute('**/api/tests?*');                             // then prove recovery against the real server
```

A fault that needs a *different graph* (not a different response) belongs in the fixture, not in a handler.

## MCP data flow (`mcp.pw.spec.ts`)

Serial, own temp workspace: `StdioClientTransport` spawns `node packages/cli/dist/cli.js mcp --graph <tmp>`;
the spec calls `graph_overview`, `search_graph`, `describe_node` (arg `node_id`), `test_coverage`, then appends a
function to the fixture copy, calls `refresh_graph` (which writes graph.json in place) and checks the node
through MCP, on disk, and through its own server's `POST /api/sync` + `GET /graph`. Use existing tool names only.

## How results reach Farsight

`farsight.config.json → tests.e2e` names `e2e/test-results/results.json` (runner `playwright`). `pnpm e2e`
stamps `farsight.sourceDigest` — the content digest of this checkout computed the way ingest computes it,
workspace excludes included (`farsight digest --repo farsight .`) — so freshness reads *unchanged* until a
source file changes. Any `.ts`/`.js`/`.mjs` edit after the run makes it *changed*: re-run `pnpm e2e` before
you show freshness. To see it without touching the dogfood `graph.json`:

```sh
cd "$(mktemp -d)" && node <repo>/packages/cli/dist/cli.js ingest <repo> --repo farsight \
  --exclude "examples/**,prototypes/**" --out "$PWD/graph.json"
node <repo>/packages/cli/dist/cli.js tests list --level e2e --graph graph.json
```

On the live dogfood server, `curl -X POST localhost:4477/api/sync` picks it up (restart first if the build
changed). MCP: `test_coverage { node: "farsight::packages/server/public/app/shell.js::setLens" }`.

## Screenshots

Judge a visual change by looking at the PNG, not by querying the DOM (AGENTS.md). Failure screenshots land in
`e2e/test-results/artifacts/<test>/test-failed-1.png`; for ad-hoc shots open one fresh page per shot, wait on
the surface's own selector, and collect `pageerror` + console errors — `pageErrors` does the latter for you.

## Generic references (load on demand)

These were written for an Electron app and carried over: where they say `electronApp` / `firstWindow()`, read
the `page` fixture; the Electron-only parts (IPC, `ELECTRON_RUN_AS_NODE`, main-process logs, visual baselines)
do not apply. Files they link to that are not listed here were pruned as Electron- or app-specific.

| topic | file |
|---|---|
| Locators & selection strategy | `references/locators.md`, `references/locator-api.md`, `examples/selector-strategies.md` |
| Web-first assertions, auto-waiting | `references/expect-assertions.md`, `references/auto-waiting.md` |
| Timeouts | `references/timeouts.md` |
| Debugging & traces | `references/debugging.md`, `references/trace-viewer.md` |
| Page objects (not used — `support.ts` helpers are enough at this size) | `references/page-objects.md` |
| Anti-patterns | `references/anti-patterns.md` |
