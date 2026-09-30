# Expect Assertions

Playwright's `expect` from `@playwright/test` is **web-first** — locator-targeted matchers auto-retry until they pass or `expect.timeout` (5s default) elapses.

## Always import from the test entry

```ts
import { test, expect } from '@playwright/test';
// or — if your project re-exports through fixtures:
import { test, expect } from './fixtures';
```

The `expect` from `@playwright/test` extends Jest's `expect` with Playwright matchers and `await` semantics.

## Auto-retrying matchers (use `await`)

These are re-tested until pass or `expect.timeout`. **Always `await` them.**

| Matcher                                             | Asserts                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `expect(locator).toBeAttached()`                    | Element is in the DOM                                            |
| `expect(locator).toBeVisible()`                     | Visible (non-empty bbox, not `display:none`/`visibility:hidden`) |
| `expect(locator).toBeHidden()`                      | Not visible (or detached)                                        |
| `expect(locator).toBeChecked()`                     | Checkbox/radio is checked                                        |
| `expect(locator).toBeDisabled()`                    | `disabled` or `aria-disabled=true`                               |
| `expect(locator).toBeEnabled()`                     | Not disabled                                                     |
| `expect(locator).toBeEditable()`                    | Enabled and not readonly                                         |
| `expect(locator).toBeEmpty()`                       | No children/value                                                |
| `expect(locator).toBeFocused()`                     | Currently has focus                                              |
| `expect(locator).toBeInViewport()`                  | Intersects viewport (use `{ratio}` for partial)                  |
| `expect(locator).toContainText(text)`               | Text contains substring/regex                                    |
| `expect(locator).toHaveText(text)`                  | Text matches exactly (string, regex, or array for lists)         |
| `expect(locator).toContainClass(name)`              | Has CSS class (regex or array OK)                                |
| `expect(locator).toHaveClass(name)`                 | Has exactly these classes (string\|regex\|array)                 |
| `expect(locator).toHaveAttribute(name, value?)`     | DOM attribute matches (value optional)                           |
| `expect(locator).toHaveCount(n)`                    | Locator matches exactly N elements                               |
| `expect(locator).toHaveCSS(name, value)`            | Computed CSS property                                            |
| `expect(locator).toHaveId(id)`                      | `id` attribute                                                   |
| `expect(locator).toHaveJSProperty(name, value)`     | JS property (e.g. `value`, `checked`)                            |
| `expect(locator).toHaveRole(role)`                  | ARIA role                                                        |
| `expect(locator).toHaveValue(value)`                | Input value (string\|regex)                                      |
| `expect(locator).toHaveValues(values)`              | Multi-select selected options                                    |
| `expect(locator).toHaveAccessibleName(text)`        | Accessible name                                                  |
| `expect(locator).toHaveAccessibleDescription(text)` | Accessible description                                           |
| `expect(locator).toHaveScreenshot(name?, options?)` | Pixel-diff visual snapshot                                       |
| `expect(locator).toMatchAriaSnapshot(yaml)`         | Aria-tree snapshot                                               |
| `expect(page).toHaveTitle(title)`                   | Page title                                                       |
| `expect(page).toHaveURL(url)`                       | Page URL                                                         |
| `expect(page).toHaveScreenshot(name?, options?)`    | Page-level snapshot                                              |
| `expect(response).toBeOK()`                         | Response status 200-299                                          |

### Examples

```ts
import { test, expect } from './fixtures';

test('basic web-first assertions', async ({ page }) => {
  await expect(page).toHaveTitle(/CoPilot/);
  await expect(page).toHaveURL(/#\/work/);
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  await expect(page.getByLabel('Email')).toHaveValue('me@example.com');
  await expect(page.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByTestId('toast')).toContainText('Saved');
  await expect(page.getByLabel('Subscribe')).toBeChecked();
  await expect(page.locator('main')).not.toBeEmpty();
  await expect(page.getByTestId('status')).toHaveAttribute('aria-live', 'polite');
});
```

## Negation — `.not`

```ts
await expect(loc).not.toBeVisible();
await expect(loc).not.toContainText('Error');
expect(value).not.toEqual(0);
```

## Custom assertion message

```ts
await expect(page.getByText('Welcome'), 'should be logged in').toBeVisible();
expect(value, 'session should have started').toBeGreaterThan(0);
```

## Per-call timeout override

```ts
await expect(loc).toHaveText('Loaded', { timeout: 30_000 });
await expect(loc).toBeVisible({ timeout: 0 }); // wait indefinitely
```

## Soft assertions (don't fail the test immediately)

```ts
test('multi-check', async ({ page }) => {
  await expect.soft(page.getByTestId('status-1')).toHaveText('OK');
  await expect.soft(page.getByTestId('status-2')).toHaveText('OK');
  await expect.soft(page.getByTestId('status-3')).toHaveText('OK');
  // continues even if any of the above fail; the test fails at the end
});

// stop early if soft assertions accumulated:
expect(test.info().errors).toHaveLength(0);
```

## `expect.configure(options)`

Build a customized expect:

```ts
const slowExpect = expect.configure({ timeout: 30_000 });
const softExpect = expect.configure({ soft: true });

await slowExpect(page.getByTestId('slow-load')).toHaveText('Loaded');
await softExpect(page.getByTestId('warning')).toBeHidden();
```

## `expect.poll(asyncFn).toMatcher(value)`

Turn any sync matcher into a polling assertion. Useful for non-locator values that need retry semantics:

```ts
await expect
  .poll(
    async () => {
      const response = await page.request.get('https://api.example.com/status');
      return response.status();
    },
    {
      message: 'API should eventually return 200',
      timeout: 30_000,
      intervals: [500, 1000, 2000],
    },
  )
  .toBe(200);

// In Electron — poll a main-process value
await expect
  .poll(
    async () =>
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  )
  .toBe(2);
```

## `expect(async fn).toPass(options?)`

Retry a whole assertion block until it passes. Default timeout is **0** (no limit) — set explicitly:

```ts
await expect(async () => {
  const sessions = await invokeIPC<unknown[]>(page, 'cli:list-sessions');
  expect(sessions.length).toBeGreaterThan(0);
}).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });
```

## Non-retrying matchers (sync)

For values that are already resolved (numbers, strings, arrays — not Locators):

```ts
expect(2 + 2).toBe(4);
expect(name).toEqual('Jared');
expect(items).toContain('apple');
expect(obj).toMatchObject({ status: 'ok' });
expect(arr).toHaveLength(3);
expect(value).toBeTruthy();
expect(value).toBeFalsy();
expect(value).toBeNull();
expect(value).toBeUndefined();
expect(value).toBeDefined();
expect(value).toBeNaN();
expect(value).toBeGreaterThan(5);
expect(value).toBeGreaterThanOrEqual(5);
expect(value).toBeLessThan(10);
expect(value).toBeLessThanOrEqual(10);
expect(value).toBeCloseTo(3.14, 2); // (number, precision)
expect(value).toBeInstanceOf(Date);
expect(str).toMatch(/^hello/);
expect(() => doThing()).toThrow();
expect(arr).toContainEqual({ id: 1 });
expect(arr).toEqual(expect.arrayContaining([1, 2]));
expect(obj).toEqual(expect.objectContaining({ a: 1 }));
expect('hello world').toEqual(expect.stringContaining('world'));
expect('abc123').toEqual(expect.stringMatching(/\d+/));
expect(obj).toStrictEqual({ a: 1 }); // deep + types
expect(obj).toHaveProperty('a.b.c', 1);
```

## Asymmetric matchers (nestable)

```ts
expect(user).toEqual({
  id: expect.any(Number),
  name: expect.stringContaining('clearp'),
  tags: expect.arrayContaining(['admin']),
  meta: expect.objectContaining({ updatedAt: expect.any(String) }),
});
```

## Custom matchers — `expect.extend`

Define your own matcher:

```ts
// e2e/expect-extensions.ts
import { expect as base, Locator } from '@playwright/test';

export const expect = base.extend({
  async toHaveAccessibleSummary(locator: Locator, expected: { name: string; role: string }) {
    const role = await locator.getAttribute('role');
    const name = await locator.getAttribute('aria-label');
    const pass = role === expected.role && name === expected.name;
    return {
      pass,
      message: () =>
        pass
          ? `expected NOT to have role=${expected.role} name=${expected.name}`
          : `expected role=${expected.role} name=${expected.name}; got role=${role} name=${name}`,
      name: 'toHaveAccessibleSummary',
    };
  },
});
```

Then re-export from your fixtures file so all specs use it:

```ts
// fixtures.ts
export { test } from '@playwright/test';
export { expect } from './expect-extensions';
```

## Common Electron-app assertions

```ts
// Page loaded
await expect(page).toHaveTitle(/Clear Path|CoPilot/);

// Sidebar nav present
await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

// Route changed (after sidebar click)
await expect(page).toHaveURL(/#\/work/);

// IPC result
const sessions = await invokeIPC<{ id: string }[]>(page, 'cli:list-sessions');
expect(sessions).toEqual(
  expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
);

// Main-process state
expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(false);

// No critical console errors (collected via fixture)
expect(test.info().attachments.find((a) => a.name === 'console-errors')).toBeUndefined();

// Visual regression
await expect(page).toHaveScreenshot('home.png', {
  mask: [page.getByTestId('time-now')],
});
```

## Anti-patterns

| Don't                                                              | Do                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| `expect(await loc.isVisible()).toBe(true)`                         | `await expect(loc).toBeVisible()`                       |
| `expect(await loc.textContent()).toBe('x')`                        | `await expect(loc).toHaveText('x')`                     |
| `await expect(loc).toBeVisible(); await page.waitForTimeout(500);` | Just the assert — it auto-retries                       |
| `expect(await loc.count()).toBe(3)`                                | `await expect(loc).toHaveCount(3)`                      |
| Passing locator to non-retry matcher: `expect(loc).toBeTruthy()`   | Use a retry matcher: `await expect(loc).toBeAttached()` |
