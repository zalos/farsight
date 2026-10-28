# Trace Viewer

Playwright's trace viewer is a time-travel debugger for tests — DOM snapshots before/during/after every action, network log, console log, source code, errors, attachments. **The single biggest debugging upgrade over WDIO.**

## Configure tracing

### Per-test runner mode (`use.trace`)

```ts
// playwright.config.ts
use: {
  trace: 'on-first-retry',
}
```

| Mode                              | When traces are saved                       |
| --------------------------------- | ------------------------------------------- |
| `'off'`                           | Never                                       |
| `'on'`                            | Always (slow & disk-hungry; useful locally) |
| `'on-first-retry'`                | Only on retry — recommended for CI          |
| `'on-all-retries'`                | Every retry                                 |
| `'retain-on-failure'`             | Captured always; retained only on failure   |
| `'retain-on-first-failure'`       | Captured always; retained on first failure  |
| `'retain-on-failure-and-retries'` | Combination                                 |

For desktop-app CI, `'on-first-retry'` gives you traces for flaky tests without paying the capture cost on every successful run.

CLI override:

```bash
npx playwright test --trace on
npx playwright test --trace retain-on-failure
```

### Library mode (Electron) — context-level

If you want to record a trace for a specific block (or your `electronApp` fixture predates the runner), use the BrowserContext API directly:

```ts
const ctx = electronApp.context();
await ctx.tracing.start({
  screenshots: true,
  snapshots: true,
  sources: true,
  title: 'sessions list',
});
// run your test ...
await ctx.tracing.stop({ path: 'test-results/sessions-list.zip' });
```

Or `start`/`stopChunk` for multiple traces in one session:

```ts
await ctx.tracing.start({ screenshots: true, snapshots: true });
await ctx.tracing.startChunk();
// part 1 ...
await ctx.tracing.stopChunk({ path: 'part-1.zip' });
await ctx.tracing.startChunk();
// part 2 ...
await ctx.tracing.stopChunk({ path: 'part-2.zip' });
await ctx.tracing.stop();
```

## What's captured

A trace zip contains:

- DOM snapshot before each action
- DOM snapshot after each action
- Network requests (HTTP only — IPC isn't captured here)
- Console messages
- Page errors
- Source code references for each action
- Screenshots (if `screenshots: true`)
- Action arguments and return values

## Open a trace

### CLI

```bash
npx playwright show-trace test-results/.../trace.zip
```

### Public viewer (no install)

Drag-and-drop the `.zip` into [trace.playwright.dev](https://trace.playwright.dev). The viewer runs entirely in-browser — your trace is not uploaded anywhere.

### Direct URL

```
https://trace.playwright.dev/?trace=https://your-host/trace.zip
```

(The remote URL must be CORS-accessible to the browser.)

### From CI artifacts

Upload the trace to GHA artifacts, then download and open locally:

```yaml
- uses: actions/upload-artifact@v5
  if: ${{ !cancelled() }}
  with:
    name: playwright-trace
    path: test-results/**/trace.zip
```

The HTML reporter also embeds the trace — `npx playwright show-report` lets you click a failed test and see "Open trace".

## Trace viewer UI

| Panel                     | What you see                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Timeline** (top)        | Action film strip with thumbnails. Hover to scrub.                                                                                                       |
| **Action list** (left)    | Every Playwright call with timing, status, args. Click to time-travel.                                                                                   |
| **DOM snapshot** (center) | Click "Before"/"Action"/"After" to see the page state at each phase. The snapshot is interactive — you can hover, inspect, even use DevTools-like tools. |
| **Console**               | Renderer console messages from `page.on('console')`.                                                                                                     |
| **Network**               | HTTP requests/responses. **No IPC traffic** — `page.evaluate(electronAPI.invoke)` calls are captured as `evaluate` actions, not as network.              |
| **Source**                | The exact line of test code that ran the action.                                                                                                         |
| **Errors**                | `pageerror`, action errors, assertion failures.                                                                                                          |
| **Attachments**           | Anything `testInfo.attach(...)` saved.                                                                                                                   |
| **Metadata**              | Browser, OS, viewport, env.                                                                                                                              |

### Key features

- **Pick locator** — hover over the DOM snapshot to get a suggested locator. Lets you build resilient selectors against an actual page state.
- **Time-travel** — click any action; the entire UI rewinds (DOM, console position, network position).
- **Inspect** — Chrome DevTools-style element inspection on the snapshot.

## Recording trace from `await page.pause()` / Inspector

When a test pauses (via `--debug` or `await page.pause()`), the Inspector lets you continue, step, or "record". If you click record while paused, subsequent actions go into a trace you can save.

## What goes wrong (and how trace explains it)

| Symptom                               | Trace shows                                                           |
| ------------------------------------- | --------------------------------------------------------------------- |
| Click misses target                   | Hovered point in snapshot is over a different element (z-index issue) |
| `expect(loc).toBeVisible()` times out | Snapshot shows the element is `display:none` or zero-size             |
| Locator resolves to multiple          | Action list shows "strict mode violation" with all candidates         |
| Test passes locally, fails on CI      | Compare snapshots — usually viewport/DPR/font diff                    |
| App crashed mid-test                  | "Page closed" event in action list with timing                        |
| Network error broke flow              | Network panel shows the failed request and timing                     |

## Saving traces from a custom helper

```ts
test('save trace on demand', async ({ electronApp, page }, testInfo) => {
  const ctx = electronApp.context();
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    // ...test body...
  } finally {
    const tracePath = testInfo.outputPath('trace.zip');
    await ctx.tracing.stop({ path: tracePath });
    await testInfo.attach('trace', { path: tracePath, contentType: 'application/zip' });
  }
});
```

## Trace size

Traces are typically **a few MB** per test. With `'on'` mode they can balloon — restrict with:

- `screenshots: false` — no per-action screenshots (smaller traces, less useful)
- `snapshots: false` — no DOM snapshots (much smaller, basically useless)

For large suites, `'on-first-retry'` is the sweet spot.

## Tracing across multiple specs

Each spec gets its own trace. To see them as a unified timeline, use the HTML report — it lists all tests with trace links.

## Programmatic snapshot grouping

Add a `name` to each chunk to group steps in the trace UI:

```ts
await ctx.tracing.group('login flow');
await page.getByLabel('Email').fill('me@example.com');
await page.getByRole('button', { name: 'Sign in' }).click();
await ctx.tracing.groupEnd();
```

(Requires `screenshots: true`.)

## Caveats

1. **Traces aren't free** — set to `on-first-retry` or `retain-on-failure` for production CI.
2. **Renderer console only** — main-process console logs are NOT in the trace's Console panel. Capture them via `electronApp.on('console', ...)` and attach the buffer.
3. **IPC isn't captured** — `electronAPI.invoke()` calls show up as `page.evaluate` actions; the IPC handler's response isn't visible. Use main-process trace or log instrumentation if you need that view.
4. **Trace files contain source code** — be aware before uploading to a public artifact store.

## See also

- [debugging.md](debugging.md) — full debug toolkit (Inspector, UI mode, codegen)
- [examples/debug-session.md](../examples/debug-session.md) — worked example walkthrough
