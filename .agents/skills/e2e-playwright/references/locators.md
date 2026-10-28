# Locators

Locators are Playwright's central object — they auto-wait, retry, and re-resolve on every action. Replaces WDIO's `$()` chained promises.

## Recommended order of preference

Pick the leftmost option that works. Each one further right gets less resilient to refactors.

```
getByRole > getByLabel > getByPlaceholder > getByText > getByTestId > CSS > XPath
```

### `page.getByRole(role, options?)` — preferred

Finds an element by ARIA role, optionally filtered by accessible name. **Use this for any interactive element** (buttons, links, tabs, checkboxes, headings, etc.).

```ts
await page.getByRole('button', { name: 'Save' }).click();
await page.getByRole('link', { name: 'Sessions' }).click();
await page.getByRole('tab', { name: 'Settings' }).click();
await page.getByRole('checkbox', { name: 'Subscribe' }).check();
await page.getByRole('heading', { name: 'Welcome', level: 1 });
await page.getByRole('button', { name: /^submit$/i });

// Common roles:
// button, link, tab, tabpanel, dialog, alert, menu, menuitem, navigation,
// heading, list, listitem, checkbox, radio, switch, textbox, combobox,
// option, region, status, search, banner, contentinfo, main, complementary
```

Options:

- `name` — string \| RegExp. Matches accessible name (substring by default; use regex for exact: `/^Save$/`).
- `exact` — `true` to require exact match (whitespace-normalized).
- `level` — for `heading` (1-6).
- `selected`, `checked`, `pressed`, `expanded` — boolean attribute filters.
- `disabled` — match `disabled` or `aria-disabled=true`.
- `includeHidden` — match `aria-hidden=true` elements.

### `page.getByLabel(text, options?)`

Form controls associated via `<label>`, `aria-label`, or `aria-labelledby`.

```ts
await page.getByLabel('Email').fill('a@example.com');
await page.getByLabel(/password/i).fill('secret');
```

### `page.getByPlaceholder(text)`

```ts
await page.getByPlaceholder('Search projects…').fill('clear-path');
```

### `page.getByText(text, options?)`

Match by visible text. **Best for non-interactive elements.** For buttons/links/tabs, prefer `getByRole`.

```ts
await expect(page.getByText('Welcome back')).toBeVisible();
await expect(page.getByText('Welcome', { exact: true })).toBeVisible();
await expect(page.getByText(/^Welcome,\s+\w+!$/)).toBeVisible();
```

Whitespace is normalized even in exact mode. Match is substring by default.

### `page.getByTestId(id)`

For elements you control but that don't have a stable role/text. Default attribute is `data-testid` — configure via `testIdAttribute` in `use:`.

```ts
await page.getByTestId('agent-card').click();
await page.getByTestId('toast').waitFor({ state: 'visible' });
```

### `page.getByAltText(text)` / `page.getByTitle(text)`

```ts
await expect(page.getByAltText('Compass logo')).toBeVisible();
await page.getByTitle('Connection status').hover();
```

## Generic `page.locator(selector)` — CSS / XPath

Use only when no `getBy*` works. Playwright auto-detects:

- `page.locator('button')` → CSS
- `page.locator('//button')` → XPath
- `page.locator('css=button')` / `page.locator('xpath=//button')` → explicit

```ts
await page.locator('#root').waitFor();
await page.locator('[data-screenshot-stub]');
await page.locator('xpath=//aside//a[contains(., "Settings")]');
```

## Filtering

### `.filter({ hasText, hasNotText, has, hasNot, visible })`

```ts
// Items containing text
await page.getByRole('listitem').filter({ hasText: 'Product 2' }).click();

// Items NOT containing text
await expect(page.getByRole('listitem').filter({ hasNotText: 'Out of stock' })).toHaveCount(5);

// Items containing a descendant locator
await page
  .getByRole('listitem')
  .filter({ has: page.getByRole('heading', { name: 'Product 2' }) })
  .getByRole('button', { name: 'Add to cart' })
  .click();

// Visible filter (skip display:none)
await page.locator('button').filter({ visible: true }).first().click();
```

### Chaining — descendant scope

A locator can be queried from another locator. The right side is scoped to the left:

```ts
const agentCard = page.getByTestId('agent-card').filter({ hasText: 'Code Reviewer' });
await agentCard.getByRole('button', { name: 'Edit' }).click();
await expect(agentCard.getByText('Last run')).toBeVisible();
```

### `.and(other)` / `.or(other)`

```ts
// Match elements that are BOTH a button AND have title="Subscribe"
const subscribeBtn = page.getByRole('button').and(page.getByTitle('Subscribe'));

// Match either-or — useful when one of two things appears
const dialog = page.getByText('Confirm settings');
const newEmail = page.getByRole('button', { name: 'New email' });
await expect(newEmail.or(dialog).first()).toBeVisible();
```

## Strictness

Locators throw if an action targets >1 element. To opt out, use `.first()`, `.last()`, `.nth(n)` — but treat that as a code smell. The scoped/filter approach is preferred.

```ts
await page.getByRole('button').first().click(); // works but fragile
await page.getByRole('button', { name: 'Save' }).click(); // strict — preferred
```

Multi-element ops are fine on the same locator:

```ts
const items = page.getByRole('listitem');
await expect(items).toHaveCount(3);
const all = await items.all();
const texts = await items.allTextContents();
```

## Lists

```ts
// Count
await expect(page.getByRole('listitem')).toHaveCount(3);

// Exact text array (ordered)
await expect(page.getByRole('listitem')).toHaveText(['Apple', 'Banana', 'Orange']);

// Iterate (always for...of, never forEach)
for (const row of await page.getByRole('listitem').all()) {
  console.log(await row.textContent());
}

// Evaluate-all (in browser context)
const titles = await page
  .getByRole('listitem')
  .evaluateAll((list) => list.map((el) => el.textContent ?? ''));
```

## Frames and shadow DOM

- `getBy*` selectors **pierce open shadow roots** by default.
- Closed shadow roots are unsupported.
- For `<iframe>`/`<webview>`:
  ```ts
  const frame = page.frameLocator('#my-iframe');
  await frame.getByRole('button', { name: 'Save' }).click();
  ```
- XPath does NOT pierce shadow DOM — another reason to prefer `getBy*`.

## Project-specific patterns (a desktop app)

### Sidebar navigation

The sidebar (`<aside>`) contains main nav links plus pinned-bottom links (Connect, Settings) outside the `<nav>`. The `<a>` elements have role="link":

```ts
// Best
await page.getByRole('link', { name: 'Sessions' }).click();
await page.getByRole('link', { name: 'Settings' }).click();

// XPath fallback (matches WDIO's existing pattern):
await page.locator('xpath=//aside//a[contains(., "Settings")]').click();
```

### Tabs (Configure page)

The Configure page renders tabs as `<button id="tab-${key}" role="tab">`:

```ts
await page.getByRole('tab', { name: 'Settings' }).click();
// or by id (sometimes faster/clearer):
await page.locator('#tab-settings').click();
```

The `Settings` sidebar link AND the `Settings` tab button both contain "Settings" — that's why the WDIO suite uses XPath `not(@role='tab')` to disambiguate. In Playwright `getByRole` already disambiguates by role, so you rarely need this.

### Hash-routed pages

After clicking a sidebar link, the URL becomes `file:///.../#/work?tab=session`. Don't use `page.waitForURL()` (file URLs aren't reliably matchable); instead wait for the new content:

```ts
await page.getByRole('link', { name: 'Sessions' }).click();
await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
```

### Toast notifications

The app emits transient toasts at `[data-testid="toast"]`. Always assert with `toContainText`/`toBeVisible`, not on a captured handle (toasts disappear):

```ts
await expect(page.getByTestId('toast')).toContainText('Saved');
```

## When to use `page.locator()` over `getBy*`

- **Existing IDs** with no good role/name — `page.locator('#root')`, `page.locator('#tab-settings')`
- **Data attributes** that aren't `data-testid` — `page.locator('[data-screenshot-stub]')`
- **Compound queries** that need `:has()`, `:nth-of-type()`, etc. — but consider `.filter()` first
- **XPath** for complex sibling relationships not expressible as filter

Avoid:

- Tailwind class selectors (`.bg-purple-500 .flex`) — these change constantly
- Index-based picks without a filter — `tr:nth-child(3)` is brittle
- Text-prefix selectors with overlap — `getByText('Save')` matches both `Save` and `Save & Close`; use `exact: true` or regex
