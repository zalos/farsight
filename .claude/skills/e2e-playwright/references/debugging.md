# Debugging

Playwright ships with several debug tools — Inspector, UI mode, trace viewer, codegen, verbose logging. Each one is worth learning.

## `await page.pause()` — programmatic breakpoint

Drop into a spec to halt at a specific point and open the Inspector.

```ts
test('debug me', async ({ page }) => {
  await page.getByRole('link', { name: 'Sessions' }).click();
  await page.pause(); // ← Inspector opens here
  await page.getByRole('button', { name: 'New Session' }).click();
});
```

The Inspector lets you:

- Step through actions (Resume / Step over)
- **Live-edit locators** in the toolbar; matching elements highlight in the page
- Use **Pick Locator** — hover any element on the page to copy a robust locator string
- See actionability log (visible/enabled/stable/scroll-into-view)
- Re-run failed actions

When the test ends or you click Resume, the page closes and Playwright returns the test exit status.

## `--debug` flag

```bash
npx playwright test --debug
npx playwright test e2e/smoke.pw.spec.ts --debug
npx playwright test e2e/smoke.pw.spec.ts:42 --debug   # specific line
```

`--debug` implies:

- `--headed`
- `--workers=1`
- `--max-failures=1`
- `--timeout=0` (no auto-fail)
- `PWDEBUG=1` (Inspector opens automatically; pauses at the start of each test)

For Electron, this works the same as for a browser — the Electron window opens and the Inspector controls it.

## UI Mode — the time-travel test runner

```bash
npx playwright test --ui
```

UI mode is a graphical wrapper around the test runner with:

- **Watch mode** — re-run a test on file save
- **Trace viewer** for every test (built in)
- **Filter** by tag, project, status
- **Timeline scrub** for each test
- **Pick locator** on a paused test

Best for active development of a new spec. Doesn't work as well on Electron (no auto-detection of the spawned Electron window in the timeline pane), but the trace viewer integration is fully functional.

## Trace viewer (post-mortem)

For CI failures or any post-mortem analysis, the trace viewer is the answer. See [trace-viewer.md](trace-viewer.md).

```bash
npx playwright show-trace test-results/.../trace.zip
```

## Codegen — record a flow

```bash
npx playwright codegen
```

For browser tests this opens a browser + recorder. For Electron, the workaround is `await page.pause()` — the Inspector includes the recorder controls.

When stopped at `page.pause()`, click "Record" in the Inspector toolbar; subsequent actions are written as code in the right-hand panel. Copy/paste into your spec.

Useful flags (browser-mode codegen):

- `--target javascript|playwright-test|python|java|csharp` — output format
- `--test-id-attribute data-pw` — generate `getByTestId` for that attribute
- `--save-storage auth.json` — persist auth at end of session

## Verbose logging

```bash
DEBUG=pw:api npx playwright test       # all API calls
DEBUG=pw:browser npx playwright test   # browser launch issues
DEBUG=pw:* npx playwright test         # everything (very chatty)
```

For Electron, `pw:browser` shows the launch invocation including args/env — useful when diagnosing "why isn't the window opening".

## VSCode

Two options.

### 1. Extension (recommended)

Install the **Playwright Test for VSCode** extension. It provides:

- Inline test runner buttons next to each `test()` declaration
- "Pick Locator" via command palette
- "Show Trace Viewer" on a failed run
- Breakpoint debugging (works with Electron — set a breakpoint, click "Debug Test")

### 2. launch.json

For finer control:

```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Playwright: current spec",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["playwright", "test", "${file}", "--headed", "--workers=1"],
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal",
      "env": {
        "ELECTRON_RUN_AS_NODE": ""
      }
    }
  ]
}
```

⚠️ **Set `ELECTRON_RUN_AS_NODE` to empty string** in launch.json — otherwise VS Code's terminal env will set it to `1` and break the launch.

## Capturing renderer console errors

Wire a fixture that listens for console errors and attaches them on failure:

```ts
// fixtures.ts
page: async ({ electronApp }, use, testInfo) => {
  const window = await electronApp.firstWindow();
  const errors: string[] = [];
  window.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[${msg.type()}] ${msg.text()}`);
  });
  window.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack}`));
  await window.waitForLoadState('domcontentloaded');
  await use(window);
  if (testInfo.status !== testInfo.expectedStatus && errors.length) {
    await testInfo.attach('console-errors', {
      body: errors.join('\n'),
      contentType: 'text/plain',
    });
  }
},
```

## Capturing main-process logs

```ts
electronApp: [async ({}, use) => {
  const app = await electron.launch(/* ... */);
  app.process().stdout?.on('data', (b) => process.stdout.write(`[main] ${b}`));
  app.process().stderr?.on('data', (b) => process.stderr.write(`[main:err] ${b}`));
  app.on('console', (msg) => console.log(`[main:console] ${msg.text()}`));
  await use(app);
  await app.close();
}, { scope: 'worker' }],
```

## Common failure modes

| Symptom                                         | First check                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `electron.launch` hangs / "browser closed"      | `ELECTRON_RUN_AS_NODE` set? `out/main/index.js` exists? Run `node scripts/check-playwright-setup.mjs`        |
| Test passes locally, fails on CI                | Snapshot mismatch — open the failed `-actual` vs `-expected` in HTML report                                  |
| "strict mode violation" — locator resolved to N | Add `getByRole(... { name: 'X' })` or `.filter({ hasText: 'X' })`                                            |
| `expect(loc).toBeVisible()` times out           | Open trace; check the "After" snapshot to see if the element is `display:none` or covered by another element |
| Click registered but state didn't change        | Open trace; check the network panel for a failed request, or the console for a renderer error                |
| Test flakes once per dozen runs                 | Set `trace: 'on-first-retry'` and `retries: 2`; investigate the retry trace                                  |
| `electron-store` data leaks across tests        | Use the `userDataDir` worker fixture pattern — see `fixtures.md`                                             |
| `dialog.showOpenDialog` never returns in test   | Mock it via `electronApp.evaluate` BEFORE the click — see [electron-api-mocking.md](electron-api-mocking.md) |
| Visual diff = "anti-alias jitter"               | Set `maxDiffPixelRatio: 0.02` or higher; or pin DPR via `--force-device-scale-factor=1`                      |

## Single-spec runs

```bash
# By file
npx playwright test e2e/smoke.pw.spec.ts

# By line in file
npx playwright test e2e/smoke.pw.spec.ts:42

# By test title (regex)
npx playwright test -g "navigates to Sessions"

# Last failed only
npx playwright test --last-failed
```

## Stepping through with Node Inspector

When `--debug` opens the Inspector, the Chromium DevTools also attaches to the renderer. Set DOM breakpoints, watch network, modify CSS — anything you'd do in DevTools normally.

Note: in Electron the renderer is Chromium, so this works exactly the same as a browser test.

## What `PWDEBUG=console` gives you

```bash
PWDEBUG=console npx playwright test
```

When the test pauses (via `await page.pause()` or `--debug`), the Inspector exposes a `playwright` global in the **DevTools console** of the page:

```js
playwright.$('button'); // first matching element
playwright.$$('button'); // all
playwright.inspect('#root'); // reveal in Elements panel
playwright.locator('button', { hasText: 'Save' });
playwright.selector($0); // generate selector for $0 (the inspected element)
```

This is the closest equivalent to WDIO's `browser.debug()` REPL.
