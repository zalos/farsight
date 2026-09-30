# E2E Anti-Patterns to Avoid

Distilled from real PR review feedback on the Playwright migration. Every item here is something a reviewer caught — write tests that wouldn't pass these reviews on the first try.

---

## 1. Silent-pass guards in tests

The most common source of false-confidence tests. A test that says "verifies X" but only runs assertions when X happens to be present is worse than no test — it gives a green CI signal while masking real regressions.

```ts
// ❌ Anti-pattern — passes silently if the tab is missing
test('clicking Activity tab gives it active styling', async ({ page }) => {
  const btn = page.getByRole('button', { name: 'Activity' }).first()
  if ((await btn.count()) > 0) {              // silent skip
    await btn.click()
    expect(...).toBe(...)
  }
})

// ❌ Same anti-pattern — beforeEach falls through if the tab is missing,
// then the test runs against whatever section happens to render
test.beforeEach(async ({ page }) => {
  const btn = page.getByRole('button', { name: 'Identity' }).first()
  if ((await btn.count()) > 0) {              // silent skip
    await btn.click()
  }
})

// ❌ The "find a link by tabbing" pattern with no failure path
let foundLink = false
for (let i = 0; i < 10; i++) {
  await page.keyboard.press('Tab')
  if ((await page.evaluate(() => document.activeElement?.tagName)) === 'A') {
    foundLink = true
    break
  }
}
if (foundLink) {                               // never asserts foundLink === true
  await page.keyboard.press('Enter')
  expect(...).toBe(...)
}

// ❌ IPC payload guard
const result = (await invokeIPC(page, 'branding:get')) as Record<string, unknown>
if (result && result.appName) {               // skips assertion if missing
  expect(result.appName).toBe('My Custom App')
}
```

**Fix** — assert the precondition and let it fail with a clear message if violated:

```ts
// ✅ A required built-in tab MUST be present
test.beforeEach(async ({ page }) => {
  const btn = page.getByRole('button', { name: 'Identity' }).first();
  await expect(btn).toBeVisible(); // hard precondition
  await btn.click();
});

// ✅ Find-by-tab — assert with a descriptive failure message
let foundLink = false;
for (let i = 0; i < 20; i++) {
  await page.keyboard.press('Tab');
  if ((await page.evaluate(() => document.activeElement?.tagName)) === 'A') {
    foundLink = true;
    break;
  }
}
expect(
  foundLink,
  'Tab navigation never reached an <a> within 20 presses — sidebar not keyboard-reachable',
).toBe(true);

// ✅ IPC round-trip — every step is a hard expectation
const result = (await invokeIPC(page, 'branding:get')) as Record<string, unknown>;
expect(result).toBeTruthy();
expect(result.appName).toBe('My Custom App');
```

**When `if (count > 0)` IS legitimate**: only when the element is intentionally feature-gated (e.g. an extension-contributed sidebar entry). In that case use `test.skip()` with a reason so the skip is visible in the report:

```ts
// ✅ Genuinely optional surface (extension only mounts when installed)
const ext = page.locator('aside').getByRole('link', { name: 'Backstage' });
if ((await ext.count()) === 0) {
  test.skip(true, 'Backstage extension not installed in this build');
  return;
}
```

---

### 1a. Selectors that can never match the real DOM

A subspecies of silent-pass: a selector typed against the wrong tag/attribute combination matches zero elements forever, then the `if (count > 0)` guard around it makes the test pass without doing anything.

```ts
// ❌ HomeHub action cards are <button onClick={navigate(...)}> NOT <a> —
// `a[href*="/work"]` matches nothing on this page, ever.
const cardLink = page.locator('a[href*="/work"]').first()
if ((await cardLink.count()) > 0) {
  await cardLink.click()
  expect(...).toContain('/work')   // never runs
}
```

**Fix** — use the actual element type and click via accessible name:

```ts
// ✅ Click the button by its visible text, then assert the route change
await page.getByRole('button', { name: /Ask a question or get guidance/ }).click();
await page.waitForTimeout(500);
const hash = await page.evaluate(() => window.location.hash);
expect(hash).toContain('/work');
expect(hash).toContain('wizard');
```

Sniff test for this anti-pattern: any time you write a CSS attribute selector (`[href*=...]`, `[class*=...]`, `[data-foo=...]`), open the actual rendered HTML in DevTools and verify the attribute exists. If it doesn't, your test is broken even if it's "passing."

### 1b. Trivially-true substring assertions

`expect(html.includes('button')).toBe(true)` is true for almost any non-empty page — it matches the literal word "button" inside any rendered class name, `<button>` tag, button-related text, etc. The test passes when nothing it's supposedly checking is actually present.

```ts
// ❌ Always true on any page that has any button anywhere
test('action cards have clickable links/buttons', async ({ page }) => {
  const html = await getRootHTML(page);
  const hasClickable = html.includes('href') || html.includes('button') || html.includes('onClick');
  expect(hasClickable).toBe(true);
});
```

**Fix** — assert on the actual content the test claims to verify:

```ts
// ✅ Check each card heading explicitly — if a card is removed or renamed,
//    the test fails with a clear "expected text not found" message.
test('all four action cards render with their headings', async ({ page }) => {
  for (const heading of [
    'Ask a question or get guidance',
    'Write or do something',
    'Explore what I can do',
    'Set up my workspace',
  ]) {
    await expect(page.getByText(heading)).toBeVisible();
  }
});
```

### 1c. Incomplete data tables for crawl/loop tests

When a test iterates over an "expected" array and the source-of-truth has more entries than the test enumerates, the missing entries get zero coverage. A silent gap.

```ts
// ❌ Source has 6 sections; test only enumerates 5 — Theme Presets is silently uncovered
const tabs = ['Identity', 'Brand Colors', 'UI Colors', 'Surfaces & Mode', 'Preview'];
for (const label of tabs) await expect(page.getByRole('button', { name: label })).toBeVisible();
```

**Fix** — keep the test's array in sync with the source. Add a comment naming the source file so reviewers know where to look:

```ts
// ✅ Order matches WhiteLabel.tsx's section nav. Update both together.
const tabs = [
  'Theme Presets',
  'Identity',
  'Brand Colors',
  'UI Colors',
  'Surfaces & Mode',
  'Preview',
];
```

For visual crawls in particular, also keep an eye out for **orphan baselines** — a PNG sitting in `e2e/screenshots/baseline/` whose tag isn't in any data table means a previous spec entry was deleted but the baseline wasn't (or — like our case — the baseline was added to LFS but the corresponding crawl entry was never wired up). Periodic check:

```bash
# Tags in the baseline dir that don't appear in any data table
ls e2e/screenshots/baseline/*.png | xargs -n1 basename | sed 's/\.png$//' | \
  while read tag; do grep -q "$tag" e2e/screenshot-crawl*.pw.spec.ts || echo "ORPHAN: $tag"; done
```

---

## 2. Test name doesn't match what the assertion checks

Reviewers grep test titles to understand coverage. If the title lies, reviewers waste time and regressions slip through.

```ts
// ❌ Title says "verifies aria-label" — assertion only checks attachment
test('contains a nav element with aria-label', async ({ page }) => {
  await expect(page.locator('aside nav')).toBeAttached();
});

// ❌ Title says "no critical console errors" — assertion only checks array type
test('has no critical console errors on initial load', async ({ consoleErrors }) => {
  expect(Array.isArray(consoleErrors)).toBe(true); // always true
});

// ❌ Title says "after navigating to Work" — test never navigates anywhere
test('has no new critical errors after navigating to Work', async ({ consoleErrors }) => {
  expect(Array.isArray(consoleErrors)).toBe(true);
});
```

**Fix** — make the assertion match the title, OR rename the test to match the assertion:

```ts
// ✅ Title and assertion aligned
test('contains a nav element with aria-label="Primary"', async ({ page }) => {
  const nav = page.locator('aside nav');
  await expect(nav).toBeAttached();
  await expect(nav).toHaveAttribute('aria-label', 'Primary');
});

// ✅ Strict empty assertion matches the title
test('has no critical console errors on initial load', async ({ consoleErrors }) => {
  expect(consoleErrors).toEqual([]);
});

// ✅ Either delete the test, or actually do the navigation in the body
test('navigates to Sessions without console errors', async ({ page, consoleErrors }) => {
  await navigateSidebarTo(page, 'Sessions');
  await expect(page.locator('#root')).toBeAttached();
  expect(consoleErrors).toEqual([]);
});
```

---

## 3. `consoleErrors` is test-scoped — sibling tests don't share it

The `consoleErrors` fixture buffer resets per test. A test like `test('no errors after rapid navigation')` that does NOT do the navigation in its own body covers nothing — the prior test's interactions ran in a separate fixture invocation and its errors are gone.

```ts
// ❌ "After interactions" but the interactions happen in a sibling test
test('cycles through all tabs without crashing', async ({ page }) => {
  for (const tab of TABS) await navigateToTab(page, tab);
});

test('has no critical errors after cycling all tabs', async ({ consoleErrors }) => {
  // consoleErrors from this test only — does NOT include the cycle above
  expect(consoleErrors).toEqual([]);
});
```

**Fix** — merge the interactions and the assertion into ONE test:

```ts
// ✅ The interactions and the assertion share the same consoleErrors buffer
test('cycles through all tabs without crashing or console errors', async ({
  page,
  consoleErrors,
}) => {
  for (const tab of TABS) await navigateToTab(page, tab);
  expect(consoleErrors).toEqual([]);
});
```

If you need the assertion to live in its own test (e.g. for clarity), rename it to truthfully describe what it covers (the page fixture's load + this test's body — NOT prior tests).

---

## 4. Listeners attached after the page has already loaded

`page.on('console')` only fires for events AFTER the listener is attached. Playwright does not buffer past events. If you attach listeners AFTER `waitForLoadState` or `#root.waitFor`, you miss every renderer error from initial load — the most common place for React mount errors.

```ts
// ❌ consoleErrors fixture depends on `page`; runs AFTER page.waitForLoadState
page: async ({ electronApp }, use) => {
  const win = await electronApp.firstWindow()
  await win.waitForLoadState('domcontentloaded')   // errors fire here
  await win.locator('#root').waitFor(...)          // and here
  await use(win)
}

consoleErrors: [
  async ({ page }, use) => {
    page.on('console', ...)                         // too late — already loaded
    page.on('pageerror', ...)
  }
]
```

**Fix** — attach listeners as the very first thing after `firstWindow()`:

```ts
// ✅ Attach BEFORE any waits or emulation
const pageErrorsMap = new WeakMap<Page, string[]>()

page: async ({ electronApp }, use) => {
  const win = await electronApp.firstWindow()

  const errors: string[] = []
  win.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })
  win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  pageErrorsMap.set(win, errors)

  // Now wait for load — any errors fired during load land in `errors`
  await win.waitForLoadState('domcontentloaded')
  await win.locator('#root').waitFor(...)
  await use(win)
}

consoleErrors: [
  async ({ page }, use) => {
    await use(pageErrorsMap.get(page) ?? [])
  },
  { auto: true },
]
```

---

## 5. Unscoped CSS locators that can match the wrong element

`page.locator('nav').first()` happily matches whatever `<nav>` happens to be earliest in the DOM — including a tab strip elsewhere on the page. The test passes even when the actual sidebar is missing.

```ts
// ❌ Matches any <nav> on the page
await expect(page.locator('nav').first()).toBeAttached();

// ❌ Same problem with broad `nav a`
const count = await page.locator('nav a').count();

// ❌ XPath compounds for compound text matches — fragile
await page.locator('xpath=//button[not(@role="tab") and contains(., "Settings")]').click();
```

**Fix** — prefer role+name lookups for accessible elements; scope CSS to a known container otherwise:

```ts
// ✅ Role + accessible name — survives DOM/CSS refactors
await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

// ✅ Scoped CSS — `aside a` matches only sidebar anchors
const count = await page.locator('aside a').count();

// ✅ Role + name beats XPath for "the Settings button that isn't a tab"
await page.getByRole('button', { name: 'Settings' }).click();
```

Order of preference for selectors:

1. `getByRole(role, { name })` — best, screen-reader-aligned
2. `getByText(...)` for non-interactive elements
3. `getByLabel(...)` for form controls
4. `getByTestId(...)` for non-text-bearing elements you control
5. CSS — only when nothing above works (e.g. `#root`, `[data-screenshot-stub]`)
6. XPath — last resort

---

## 6. Stale comments after refactors

Comments that describe a previous mechanism are worse than no comments — future maintainers chase the wrong knob. After every refactor, search for comments referencing the old name.

```ts
// ❌ Code uses page.emulateMedia, comment talks about a Chromium flag
// "Dark mode is forced via the --force-dark-mode Chromium flag pushed
//  into Electron launch args by fixtures.ts when APP_E2E_VISUAL=1"
if (process.env.APP_E2E_VISUAL === '1') {
  await window.emulateMedia({ colorScheme: 'dark' }); // actual mechanism
}
```

**Fix** — when you change behavior, sweep nearby comments. `git grep` for the old API name.

---

## 7. `require()` of ESM-only packages

Common stumble for v7+ packages that went ESM-only (`pixelmatch` v7, `chalk` v5, `node-fetch` v3, `nanoid` v4+, etc). `require()` of an ESM-only package throws `ERR_REQUIRE_ESM` at runtime — but won't surface during typecheck.

```ts
// ❌ pixelmatch v7 is ESM-only — this throws at runtime in compare mode
const pixelmatch = require('pixelmatch');
```

**Fix** — dynamic `import()` and cache the resolved function:

```ts
// ✅ Dynamic import + cached resolution. The wrapping function must be async.
type PixelmatchFn = (img1: Uint8Array, img2: Uint8Array, ...) => number
let pixelmatchCache: PixelmatchFn | null = null
async function loadPixelmatch(): Promise<PixelmatchFn> {
  if (pixelmatchCache) return pixelmatchCache
  const mod = (await import('pixelmatch')) as unknown as
    | { default: PixelmatchFn }
    | PixelmatchFn
  pixelmatchCache = typeof mod === 'function' ? mod : mod.default
  return pixelmatchCache
}
```

**Warning sign**: a comment that says "we use `require()` because Playwright's loader handles ESM/CJS interop" — that's wishful thinking; verify by actually running the compare path locally, not just `-u` (the "update" path may not exercise the require).

---

## 8. Auto-creating baselines silently in CI

A visual spec that auto-creates a missing baseline gives a green CI signal even when:

- Git LFS failed to pull
- A baseline was accidentally deleted in a refactor
- A new spec entry was added without committing the baseline

```ts
// ❌ Silently writes a new baseline + passes — masks LFS / commit failures
if (!fs.existsSync(baselinePath)) {
  await captureWindow(electronApp, baselinePath);
  return;
}
```

**Fix** — gate auto-create on `!process.env.CI`. Local: ergonomic auto-create. CI: throw with a hint about LFS/branch state:

```ts
// ✅ Strict on CI, ergonomic locally
if (!fs.existsSync(baselinePath)) {
  if (process.env.CI) {
    throw new Error(
      `Missing baseline for "${name}" at ${baselinePath}. ` +
        `On CI, baselines must already be committed (or invoke with -u). ` +
        `Check Git LFS pulled and the baseline exists on the branch.`,
    );
  }
  await captureWindow(electronApp, baselinePath);
  test.info().annotations.push({ type: 'note', description: `Wrote missing baseline: ${name}` });
  return;
}
```

---

## 9. Real CLI processes (or any external service) in tests

Tests that spawn `copilot`, `claude`, or other external binaries:

- Flake when the binary isn't installed (CI, fresh checkouts, non-default OS)
- Hit rate limits / cost real money
- Couple test outcomes to network availability

If the test only needs the IPC plumbing (e.g. "banner appears when a session is registered"), the spawn outcome doesn't matter — but the test name probably implies it does.

**Best practice**: stub at the adapter layer behind an env flag:

```ts
// In CLIManager, gated on an env var the test sets:
if (process.env.APP_E2E_FAKE_CLI === '1') {
  this.adapter = new FakeAdapter({ scriptedOutput: ... })
}
```

Until that's in place, prefer testing IPC handlers directly via `invokeIPC` rather than full chat flows. If you must test the spawn-and-register path, document why the test passes without the CLI installed (typically because the session record is created before the spawn outcome is observed).

---

## 10. Things that are easy to miss

- **`textContent()` returns `string | null`** — coalesce: `(await loc.textContent()) ?? ''`
- **Multi-element loops over a Locator** — `for (const x of loc)` doesn't work; use `await loc.all()` or `.allTextContents()`
- **Strict-mode violations** — `page.locator('input[type="text"]')` errors in strict mode if it matches >1; add `.first()` or use a more specific selector
- **`test.beforeAll` doesn't get a `page` fixture** — Playwright `beforeAll` runs once for the worker; the `page` fixture is per-test. If your hook needs the page, use `test.beforeEach`
- **Duplicate test titles within a `for` loop** — Playwright errors; mangle the title
- **Multi-arg `page.evaluate`** — Playwright takes a SINGLE arg; wrap in tuple: `page.evaluate(([a, b]) => ..., [a, b] as const)`
- **Worker-shared `page`** — `electronApp.firstWindow()` returns the SAME Page across tests in the same worker; clean up listeners in fixture teardown so they don't accumulate
- **Stale config-file env var assignments** — `process.env.X = '1'` in `playwright.config.ts` doesn't reach worker subprocesses; set on the parent process (npm script or CI `env:` block)
