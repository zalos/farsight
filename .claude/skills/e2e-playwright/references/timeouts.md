# Timeouts

Layered, but simpler than WDIO. There's no Mocha timer to fight.

## Layers

| Layer                        | Default                                          | Where set                                               |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| **Test timeout**             | `30000` ms                                       | `playwright.config.ts` `timeout:` / `test.setTimeout()` |
| **Expect (retry budget)**    | `5000` ms                                        | `expect.timeout` in config / per-call `{ timeout }`     |
| **Action timeout**           | `0` (no per-action limit; gated by test timeout) | `use.actionTimeout` / per-call `{ timeout }`            |
| **Navigation timeout**       | `0` (gated by test timeout)                      | `use.navigationTimeout` / `page.goto({ timeout })`      |
| **Global timeout**           | `0` (no limit)                                   | `globalTimeout:`                                        |
| **`beforeAll` / `afterAll`** | = test timeout (separate timer)                  | `test.setTimeout` inside the hook                       |
| **Fixture (default)**        | shares test timeout                              | `[fn, { timeout: ... }]` per fixture                    |
| **Worker-scoped fixture**    | = test timeout                                   | `[fn, { scope: 'worker', timeout: ... }]`               |

## Configuration

```ts
// playwright.config.ts
export default defineConfig({
  timeout: 60_000,
  globalTimeout: 30 * 60 * 1000, // 30 min ceiling for whole run
  expect: { timeout: 10_000 },
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
});
```

## Per-test override

```ts
test('slow operation', async ({ page }) => {
  test.setTimeout(120_000);
  // ...
});

// Triple the timeout
test('slow', async ({ page }) => {
  test.slow();
  // timeout becomes 90s if base is 30s
});

// Set inside beforeEach (changes test timeout)
test.beforeEach(async ({}, testInfo) => {
  if (testInfo.title.includes('crawl')) testInfo.setTimeout(testInfo.timeout + 60_000);
});
```

> **`test.slow()` does NOT work inside `beforeAll`/`afterAll`.** Use `test.setTimeout()` there.

## Per-action / per-assertion override

```ts
await page.click('button', { timeout: 30_000 });
await page.goto('about:blank', { timeout: 60_000 });
await expect(loc).toBeVisible({ timeout: 30_000 });
await expect(loc).toBeVisible({ timeout: 0 }); // wait indefinitely
```

## Hook timeouts

```ts
test.beforeAll(async ({}) => {
  test.setTimeout(120_000); // applies to this hook only
  await someSlowSetup();
});

test.afterAll(async ({}, _testInfo) => {
  // afterAll inherits the test timeout but is a separate timer
});
```

## Fixture timeouts

```ts
// Worker-scoped, custom timeout (e.g. Electron launch can take 30s on cold disk)
electronApp: [async ({}, use) => { /* ... */ }, { scope: 'worker', timeout: 60_000 }],
```

## Global timeout (whole run)

```ts
globalTimeout: 60 * 60 * 1000; // 1 hour
```

If exceeded, Playwright kills the run regardless of how many tests are left. Useful for CI to bound runtime if a test hangs.

## What counts toward the test timeout

- Test body time
- `beforeEach` / `afterEach` time
- Test-scoped fixtures (set up + tear down)
- `await test.step(...)` blocks

What does NOT count:

- Worker-scoped fixtures (own timer)
- `beforeAll` / `afterAll` (own timer)
- `globalSetup` / `globalTeardown` (one-shot, share `globalTimeout`)

## Common timeout pitfalls

### Long startup eats test budget

If `electron.launch()` takes 20s and your `timeout: 30_000`, the actual test only gets 10s. Move launch to a worker-scoped fixture so it doesn't count.

### `expect().toBeVisible()` times out faster than `actionTimeout`

`expect.timeout` is independent of `actionTimeout`. If you bumped `actionTimeout` to 30s expecting visibility checks to wait 30s too, also bump `expect.timeout`.

### `toPass` doesn't respect `expect.timeout`

```ts
await expect(async () => {
  /* ... */
}).toPass();
// default is 0 (no timeout) — almost certainly not what you want
await expect(async () => {
  /* ... */
}).toPass({ timeout: 30_000 });
```

### `waitForTimeout` is not gated

`page.waitForTimeout(60_000)` will sleep for 60s even if your test timeout is 30s — the test will fail mid-sleep. Don't use `waitForTimeout` in long stretches.

### Animation pauses don't auto-relax

`animations: 'disabled'` (in `toHaveScreenshot`) pauses transitions, but actions like `click` still wait for stability. If a transition is mid-flight when the click runs, the click may time out. Either:

- Wait for the end state explicitly: `await expect(menu).toBeVisible()`
- Or globally disable animations in the spec: `await page.addStyleTag({ content: '* { transition: none !important }' })`

## Recommended defaults for a desktop app

```ts
// playwright.config.ts
export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
});
```

These match the existing WDIO conventions (Mocha 60s, `waitforTimeout` 15s with a 10s element timeout).
