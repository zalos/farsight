# Locator API Reference

Every method on `Locator` you'll likely use, with signatures, common options, and Electron caveats.

## Action methods (auto-wait for actionability)

| Method                                                                    | Notes                                                                                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click(options?)`                                                         | `{ button?, clickCount?, delay?, force?, modifiers?, position?, timeout?, trial? }`. Modifiers: `'Alt'\|'Control'\|'ControlOrMeta'\|'Meta'\|'Shift'`. |
| `dblclick(options?)`                                                      | Same options as click.                                                                                                                                |
| `tap(options?)`                                                           | Touch tap (mobile).                                                                                                                                   |
| `hover(options?)`                                                         | `{ force?, modifiers?, position?, timeout?, trial? }`.                                                                                                |
| `focus(options?)`                                                         | `{ timeout? }`.                                                                                                                                       |
| `blur(options?)`                                                          | `{ timeout? }`.                                                                                                                                       |
| `check(options?)` / `uncheck(options?)` / `setChecked(checked, options?)` | For checkboxes/radios.                                                                                                                                |
| `fill(value, options?)`                                                   | `{ force?, timeout? }`. **Use this for React inputs** — it dispatches real input events. Empty string clears.                                         |
| `clear(options?)`                                                         | Equivalent to `fill('')`.                                                                                                                             |
| `press(key, options?)`                                                    | `key` is a single key combo like `'Enter'`, `'Control+a'`, `'ArrowDown'`.                                                                             |
| `pressSequentially(text, options?)`                                       | Type one key at a time (slower; use `fill` for forms).                                                                                                |
| `type(text, options?)`                                                    | **Deprecated** — use `fill` or `pressSequentially`.                                                                                                   |
| `selectOption(values, options?)`                                          | For `<select>`. Values can be string, array, `{ label, value, index }`.                                                                               |
| `selectText(options?)`                                                    | Select all text in element.                                                                                                                           |
| `setInputFiles(files, options?)`                                          | For `<input type="file">`. Files: path string, array of paths, or `{ name, mimeType, buffer }`.                                                       |
| `dragTo(target, options?)`                                                | `{ force?, sourcePosition?, targetPosition?, timeout?, trial? }`.                                                                                     |
| `scrollIntoViewIfNeeded(options?)`                                        | `{ timeout? }`.                                                                                                                                       |
| `dispatchEvent(type, eventInit?, options?)`                               | Synthetic event — bypasses actionability.                                                                                                             |

### Common click options

```ts
await loc.click({
  button: 'right', // 'left' (default) | 'right' | 'middle'
  modifiers: ['Control'], // hold modifier(s)
  clickCount: 2, // double click
  delay: 50, // ms between mousedown and mouseup
  force: true, // bypass actionability checks
  position: { x: 5, y: 5 }, // relative to element
  timeout: 10_000, // overrides actionTimeout
  trial: true, // run actionability without clicking
  noWaitAfter: true, // don't wait for navigation
});
```

### `fill` vs `pressSequentially`

```ts
// Recommended for forms — fast, fires real input events
await page.getByLabel('Name').fill('Ada');

// Use for typeahead/autocomplete that depends on per-keystroke handlers
await page.getByPlaceholder('Search…').pressSequentially('clearp', { delay: 50 });
```

## Read methods (NO auto-wait — use `expect()` for assertions)

| Method                                  | Returns                               | Notes                                                         |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `textContent(options?)`                 | `Promise<string \| null>`             | Includes hidden + descendant text.                            |
| `innerText(options?)`                   | `Promise<string>`                     | Visible text only.                                            |
| `innerHTML(options?)`                   | `Promise<string>`                     |                                                               |
| `inputValue(options?)`                  | `Promise<string>`                     | For input/textarea/select. **React-friendly read.**           |
| `getAttribute(name, options?)`          | `Promise<string \| null>`             | DOM attribute.                                                |
| `count()`                               | `Promise<number>`                     | Number of matches.                                            |
| `all()`                                 | `Promise<Locator[]>`                  | All matching locators.                                        |
| `allTextContents()` / `allInnerTexts()` | `Promise<string[]>`                   |                                                               |
| `boundingBox(options?)`                 | `Promise<{x,y,width,height} \| null>` |                                                               |
| `isVisible()` / `isHidden()`            | `Promise<boolean>`                    | **No retry — use `expect(loc).toBeVisible()` instead.**       |
| `isEnabled()` / `isDisabled()`          | `Promise<boolean>`                    |                                                               |
| `isChecked()`                           | `Promise<boolean>`                    |                                                               |
| `isEditable()`                          | `Promise<boolean>`                    |                                                               |
| `isFocused()`                           | `Promise<boolean>`                    |                                                               |
| `evaluate(fn, arg?, options?)`          | `Promise<R>`                          | Run a function in page context with the element as first arg. |
| `evaluateAll(fn, arg?)`                 | `Promise<R>`                          | Run a function with the array of matching elements.           |
| `evaluateHandle(fn, arg?, options?)`    | `Promise<JSHandle>`                   | Like evaluate, returns handle.                                |
| `screenshot(options?)`                  | `Promise<Buffer>`                     | Element screenshot.                                           |
| `ariaSnapshot(options?)`                | `Promise<string>`                     | Accessibility tree snapshot.                                  |
| `describe(description)`                 | `Locator`                             | Adds a label visible in trace/log.                            |

> **Don't write `expect(await loc.isVisible()).toBe(true)`** — that runs the check once and loses retry. Always use the locator-targeted matcher: `await expect(loc).toBeVisible()`.

## Wait methods

```ts
// Wait for state — 'attached' | 'detached' | 'visible' | 'hidden'
await loc.waitFor({ state: 'visible', timeout: 10_000 });
await loc.waitFor({ state: 'detached' });
```

In nearly all cases prefer `await expect(loc).toBeVisible()` — it gives a better failure message. Use `waitFor` only when you don't want to assert (e.g. in a helper that returns a value).

## Navigation methods on locator

| Method                                                                                                  | Returns                    | Notes                                          |
| ------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| `locator(selector, options?)`                                                                           | `Locator`                  | Scope a sub-query.                             |
| `filter(options)`                                                                                       | `Locator`                  | Apply a filter (see locators.md).              |
| `first()`, `last()`, `nth(i)`                                                                           | `Locator`                  | Pick one.                                      |
| `and(other)`, `or(other)`                                                                               | `Locator`                  | Compose locators.                              |
| `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId` | `Locator`                  | Same as `page.getBy*`, scoped to this locator. |
| `frameLocator(selector)`                                                                                | `FrameLocator`             | For iframes.                                   |
| `contentFrame()`                                                                                        | `FrameLocator`             | If this locator is an iframe element.          |
| `elementHandle(options?)`                                                                               | `Promise<ElementHandle>`   | **Avoid** — kept for legacy compat.            |
| `elementHandles()`                                                                                      | `Promise<ElementHandle[]>` | Avoid.                                         |
| `page()`                                                                                                | `Page`                     | The Page that owns this locator.               |

## Highlight (debugging)

```ts
await loc.highlight(); // overlays a red box on each match — visible in headed mode and trace
```

## Examples

### Click a button by name

```ts
await page.getByRole('button', { name: 'Save' }).click();
```

### Type into a labeled input

```ts
await page.getByLabel('Email').fill('me@example.com');
```

### Toggle a checkbox

```ts
await page.getByRole('checkbox', { name: 'Subscribe' }).check();
await page.getByRole('checkbox', { name: 'Subscribe' }).uncheck();
```

### Select from a dropdown

```ts
await page.getByLabel('Country').selectOption('US');
await page.getByLabel('Country').selectOption({ label: 'United States' });
await page.getByLabel('Country').selectOption(['US', 'CA']); // multi-select
```

### Upload a file

```ts
await page.getByLabel('Avatar').setInputFiles(path.join(__dirname, 'fixtures/avatar.png'));
await page.getByLabel('Avatar').setInputFiles({
  name: 'inline.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('hello'),
});
```

### Drag-and-drop

```ts
await page.getByTestId('drag-source').dragTo(page.getByTestId('drop-target'));
```

### Keyboard

```ts
await page.getByPlaceholder('Search').press('Enter');
await page.keyboard.press('Control+S'); // global keyboard
await page.keyboard.type('hello world');
await page.keyboard.down('Shift');
await page.keyboard.press('ArrowDown');
await page.keyboard.up('Shift');
```

### Mouse

```ts
await page.mouse.move(100, 200);
await page.mouse.down();
await page.mouse.move(300, 400, { steps: 10 });
await page.mouse.up();

// On an element:
const box = await loc.boundingBox();
if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
```

### Scroll

```ts
await loc.scrollIntoViewIfNeeded();

// Scroll a scrollable container
await page.locator('main').evaluate((el) => el.scrollBy(0, 400));
```

### Read text from many rows

```ts
const titles = await page.getByRole('row').filter({ hasText: 'Active' }).allTextContents();
```

### Element evaluate (run code with the DOM node)

```ts
const tagName = await loc.evaluate((el) => el.tagName);
const computedColor = await loc.evaluate((el) => getComputedStyle(el).color);
```

### Element screenshot

```ts
const buf = await loc.screenshot();
const path = 'card.png';
await loc.screenshot({ path });
```

## Anti-patterns

| Don't                                                     | Do                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `expect(await loc.isVisible()).toBe(true)`                | `await expect(loc).toBeVisible()`                                               |
| `await loc.waitForExist()` (WDIO carry-over)              | `await loc.waitFor({ state: 'attached' })` or just call the action — auto-waits |
| `await loc.elementHandle()` then operate                  | Use `Locator` directly                                                          |
| `for (const el of await loc.all()) await el.forEach(...)` | `for (const el of await loc.all()) { ... }`                                     |
| `await page.waitForTimeout(2000)`                         | `await expect(loc).toBeVisible()` (web-first) or `page.waitForFunction(...)`    |
