# Auto-Waiting & Actionability

Playwright auto-waits before every action. Understanding the actionability checks lets you diagnose flake without falling back to `waitForTimeout`.

## What runs before each action

Before performing an action, Playwright continually polls these checks until they pass or `actionTimeout` (default: no per-action timeout, gated by `expect.timeout`/`actionTimeout` config) fires:

| Action                                                                          | Visible | Stable | Receives Events | Enabled | Editable |
| ------------------------------------------------------------------------------- | :-----: | :----: | :-------------: | :-----: | :------: |
| `check`, `click`, `dblclick`, `setChecked`, `tap`, `uncheck`                    |    ✓    |   ✓    |        ✓        |    ✓    |    —     |
| `hover`, `dragTo`                                                               |    ✓    |   ✓    |        ✓        |    —    |    —     |
| `screenshot`                                                                    |    ✓    |   ✓    |        —        |    —    |    —     |
| `fill`, `clear`                                                                 |    ✓    |   —    |        —        |    ✓    |    ✓     |
| `selectOption`                                                                  |    ✓    |   —    |        —        |    ✓    |    —     |
| `selectText`                                                                    |    ✓    |   —    |        —        |    —    |    —     |
| `scrollIntoViewIfNeeded`                                                        |    —    |   ✓    |        —        |    —    |    —     |
| `blur`, `dispatchEvent`, `focus`, `press`, `pressSequentially`, `setInputFiles` |    —    |   —    |        —        |    —    |    —     |

## Definitions

| Check               | Meaning                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Visible**         | Has non-empty bounding box AND `visibility !== 'hidden'`. **`display:none` is invisible. `opacity:0` IS visible.** Zero-size box is invisible. |
| **Stable**          | Same bounding box for 2 consecutive animation frames. Animation/transition still moving = unstable.                                            |
| **Enabled**         | Not `disabled` and not `aria-disabled="true"`.                                                                                                 |
| **Editable**        | Enabled AND not `readonly`.                                                                                                                    |
| **Receives Events** | Element is the hit-test target at the click point. Overlapping elements (modals, tooltips, transparent overlays) make hit testing fail.        |

## Forcing — bypass the checks

```ts
await loc.click({ force: true });
```

`force` skips the **non-essential** checks (mostly Receives Events). It does NOT skip Visible/Enabled. Use sparingly — usually a forced click hides a real bug.

## When you DO need an explicit wait

In 95% of cases, the action's own auto-wait is enough — and `expect()` provides retry for assertions. Cases where you genuinely need an explicit wait:

### Wait for a non-DOM condition

```ts
// Wait for a global to settle
await page.waitForFunction(() => (window as any).__appReady === true);

// Wait for a value change in renderer
await page.waitForFunction(
  ([selector, target]) => document.querySelector(selector)?.textContent?.trim() === target,
  ['#status', 'Connected'] as const,
);

// Wait for a network response
const response = await page.waitForResponse('https://api.example.com/data');
expect(response.status()).toBe(200);

// Wait for a request to fire (not just response)
await page.waitForRequest('**/api/*');
```

### Wait for a new BrowserWindow (Electron)

```ts
const [newWindow] = await Promise.all([
  electronApp.waitForEvent('window'),
  page.getByRole('button', { name: 'Open settings' }).click(),
]);
await newWindow.waitForLoadState('domcontentloaded');
```

### Wait for navigation to settle

```ts
await page.waitForLoadState('domcontentloaded'); // DOM ready
await page.waitForLoadState('load'); // load event
await page.waitForLoadState('networkidle'); // no network for 500ms — avoid for chatty apps
```

### Polling assertion

```ts
await expect
  .poll(async () => (await invokeIPC<unknown[]>(page, 'cli:list-sessions')).length)
  .toBeGreaterThan(0);
```

### Retry a whole block

```ts
await expect(async () => {
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('status')).toHaveText('Ready');
}).toPass({ timeout: 30_000 });
```

## What NOT to do

```ts
// ❌ Sleep-based wait
await page.waitForTimeout(2000);

// ❌ Read-then-assert without retry
const visible = await loc.isVisible();
expect(visible).toBe(true);

// ❌ Manually polling in JS
while (!(await loc.isVisible())) await page.waitForTimeout(100);
```

All three lose Playwright's retry behavior. Use `await expect(loc).toBeVisible()` instead.

## React hydration / "the app just rendered"

For an initial app-ready check, prefer asserting on a known-stable element instead of an arbitrary delay:

```ts
// Wait for the React mount + first content
await page.locator('#root').waitFor({ state: 'attached' });
await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
```

Or — if your app's preload sets a marker — wait for that:

```ts
await page.waitForFunction(() => (window as any).electronAPI !== undefined);
```

The existing WDIO helper used `await browser.pause(1000)` after `#root` appeared. With Playwright, the `expect(navigation).toBeVisible()` follow-up usually replaces that pause because the assertion auto-retries.

## When animations cause flake

Disable animations globally for screenshots:

```ts
expect: {
  toHaveScreenshot: {
    animations: 'disabled';
  }
}
```

For non-screenshot tests where animation timing matters, prefer asserting on the END state rather than an intermediate state:

```ts
// ❌ Click and immediately check intermediate state
await page.getByRole('button', { name: 'Open' }).click();
await expect(page.getByRole('dialog')).toBeVisible(); // racy if dialog animates in

// ✅ Wait for the final state to be true
await page.getByRole('button', { name: 'Open' }).click();
await expect(page.getByRole('dialog')).toBeVisible(); // toBeVisible auto-retries until visible
await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel' })).toBeEnabled();
// ^ Once an interactive element inside the dialog is enabled, the dialog is fully open
```

## Strict mode and "element not found"

Playwright locators are **strict** — operating on a locator that matches >1 element throws. The error message lists candidates:

```
Error: strict mode violation: getByRole('button') resolved to 4 elements:
  - <button id="save">Save</button>
  - <button id="cancel">Cancel</button>
  - ...
```

Fix by adding a filter, name, or scope:

```ts
await page.getByRole('button', { name: 'Save' }).click();
// or
await page.getByTestId('toolbar').getByRole('button').first().click();
```

## "Element is unstable / receives events"

Common causes in a desktop app:

1. **Toast animation** — toast slides in over the button.
   - Fix: assert the toast is visible first, then click around it; or use `force: true` if the click target is unrelated.
2. **CSS transition** on the click target.
   - Fix: disable animations for the test (`page.addStyleTag({ content: '* { transition: none !important }' })`).
3. **Layout shift** during initial render.
   - Fix: wait for a more specific stable element first (`await expect(navigation).toBeVisible()`).
4. **Sticky header** overlapping click target.
   - Fix: `await loc.scrollIntoViewIfNeeded()` before clicking.

## Configuration

```ts
// playwright.config.ts
use: {
  actionTimeout: 10_000,        // per-action default; 0 = no timeout
  navigationTimeout: 15_000,    // page.goto(), page.waitForURL()
},
expect: {
  timeout: 10_000,              // expect() retry budget
},
```

Override per-call:

```ts
await loc.click({ timeout: 30_000 });
await expect(loc).toBeVisible({ timeout: 30_000 });
```
