# Example: Selector Strategies

How to pick the right locator for each scenario in a desktop app. Order of preference: `getByRole` > `getByLabel` > `getByPlaceholder` > `getByText` > `getByTestId` > CSS > XPath.

## Quick decision tree

| Scenario                                             | Use                            |
| ---------------------------------------------------- | ------------------------------ |
| Button, link, tab, checkbox, etc. with visible label | `getByRole(role, { name })`    |
| Form input with associated `<label>`                 | `getByLabel(text)`             |
| Unlabeled input with placeholder                     | `getByPlaceholder(text)`       |
| Heading/paragraph text                               | `getByText(text)`              |
| Element you control without a clear role/text        | `getByTestId(id)`              |
| Element with stable `id` attribute                   | `page.locator('#id')`          |
| Element with stable `data-*` attribute               | `page.locator('[data-x="y"]')` |
| Compound text matches not expressible above          | `page.locator('xpath=...')`    |

## Sidebar navigation — `getByRole('link')`

The sidebar links — including pinned-bottom ones (Connect, Settings) — are `<a>` elements. **Search the whole `<aside>`**, not just `<nav>`, since pinned links live outside `<nav>`.

```ts
// ✓ Use the role-link selector scoped to <aside>
await page.locator('aside').getByRole('link', { name: 'Sessions' }).click();
await page.locator('aside').getByRole('link', { name: 'Settings' }).click();
await page.locator('aside').getByRole('link', { name: 'Connect' }).click();

// ✓ Without scope works too if the link name is unique on the page
await page.getByRole('link', { name: 'Notes' }).click();

// ✗ Misses pinned-bottom links because they live OUTSIDE <nav>
await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
```

## Configure tabs — disambiguate "Settings" tab from "Settings" sidebar link

The Settings page has tabs rendered as `<button id="tab-${key}" role="tab">`. Both the sidebar link AND a tab button can match "Settings". Disambiguate by role:

```ts
// First navigate via the LINK (not the tab)
await page.locator('aside').getByRole('link', { name: 'Settings' }).click();

// Then click the TAB by role
await page.getByRole('tab', { name: 'Settings' }).click();

// Or by id (also works — and is sometimes faster)
await page.locator('#tab-settings').click();
```

`getByRole` already disambiguates — you almost never need the WDIO-style XPath `not(@role='tab')` workaround.

## Buttons by visible text

```ts
// Preferred — by role
await page.getByRole('button', { name: 'Save' }).click();
await page.getByRole('button', { name: /^submit$/i }).click(); // case-insensitive regex

// If the button has no role (rare — but possible with custom components)
await page.locator('button:has-text("Save")').click();

// XPath last resort
await page.locator('//button[contains(., "Save")]').click();
```

## Form inputs

```ts
// Best — by label
await page.getByLabel('Session name').fill('My session');
await page.getByLabel(/email/i).fill('me@example.com');

// By placeholder
await page.getByPlaceholder('Search projects…').fill('clearp');

// By id (when label is missing or aria-labelledby is used)
await page.locator('#session-name-input').fill('My session');

// By testid
await page.getByTestId('agent-input').fill('Code Reviewer');
```

## Lists and rows

```ts
// Asserting count
await expect(page.getByRole('listitem')).toHaveCount(3);

// Filter by text
const product = page.getByRole('listitem').filter({ hasText: 'Product 2' });
await product.getByRole('button', { name: 'Add to cart' }).click();

// Filter by descendant locator
const itemWithCheck = page.getByRole('listitem').filter({
  has: page.getByRole('checkbox', { checked: true }),
});

// Index — last resort
const second = page.getByRole('listitem').nth(1);
```

## Tables — by row name

```ts
// Match by row's accessible name (often the first cell)
const sessionRow = page.getByRole('row', { name: /My session/ });
await sessionRow.getByRole('button', { name: 'Archive' }).click();

// Filter by text content
const activeRow = page.getByRole('row').filter({ hasText: 'Active' });

// Cell scoping
const nameCell = sessionRow.getByRole('cell').first();
await expect(nameCell).toHaveText('My session');
```

## Modals and dialogs

```ts
// Scope to the dialog so other matching elements don't conflict
const dialog = page.getByRole('dialog');
await expect(dialog).toBeVisible();
await dialog.getByLabel('Confirmation').fill('DELETE');
await dialog.getByRole('button', { name: 'Confirm' }).click();
```

## Toast notifications

```ts
// The app uses [data-testid="toast"]
await expect(page.getByTestId('toast')).toContainText('Saved');

// Multiple toasts in flight — assert on the latest
await expect(page.getByTestId('toast').last()).toContainText('Latest message');
```

## Sidebar with nested test IDs

```ts
// Each sidebar item could have data-testid="sidebar-item-{key}"
await page.getByTestId('sidebar-item-sessions').click();
```

For one-off elements that don't have role/text/label, `data-testid` is faster to read in the spec and less brittle than CSS-class chains.

## XPath — when you need it

Playwright supports XPath via `page.locator('xpath=...')` or auto-detect (`page.locator('//x')`). Use cases:

```ts
// Compound: button that is NOT a tab but contains "Settings"
// (rare with role-aware locators; only needed if you can't use getByRole)
await page.locator('//button[not(@role="tab") and contains(., "Settings")]').click();

// Following-sibling
await page.locator('//label[text()="Email"]/following-sibling::input').fill('x');

// Ancestor with descendant
await page.locator('//tr[.//button[contains(., "Active")]]').first();
```

⚠️ XPath does NOT pierce shadow DOM. If your component uses a closed shadow root (some web components), XPath misses it — `getBy*` selectors handle open shadow DOM correctly.

## CSS selectors

```ts
// Stable id
await page.locator('#root').waitFor();

// Stable data attribute
await page.locator('[data-screenshot-stub]');

// CSS pseudo-classes
await page.locator('button:has-text("Save")'); // text inside
await page.locator('article:has(h2:text("Recent"))'); // descendant filter
await page.locator('button:visible'); // only visible

// Combinator
await page.locator('aside > nav > a');
```

Stay away from Tailwind class selectors — they change frequently:

```ts
// ✗ Brittle
await page.locator('.bg-purple-500.flex.items-center');
```

## Filter operators

### `.filter({ hasText })` — text inside (any descendant)

```ts
const row = page.getByRole('row').filter({ hasText: 'Active' });
```

### `.filter({ hasNotText })` — exclude rows with text

```ts
const inactive = page.getByRole('row').filter({ hasNotText: 'Active' });
```

### `.filter({ has })` — element contains a sub-locator

```ts
const rowWithButton = page.getByRole('row').filter({
  has: page.getByRole('button', { name: 'Archive' }),
});
```

### `.filter({ hasNot })` — opposite

### `.filter({ visible: true })` — visibility filter

```ts
await page.locator('.menu-item').filter({ visible: true }).first().click();
```

## Operators

### `.and()` — match both criteria

```ts
const subscribeBtn = page.getByRole('button').and(page.getByTitle('Subscribe to newsletter'));
```

### `.or()` — match either (use `.first()` if both may appear)

```ts
const newOrDialog = page
  .getByRole('button', { name: 'New' })
  .or(page.getByText('Confirm settings'));
await expect(newOrDialog.first()).toBeVisible();
```

## Strict mode debugging

When a locator matches >1 element, Playwright throws "strict mode violation" and lists candidates. Add a filter or use `getByRole` with a specific name to disambiguate.

```
Error: strict mode violation: getByRole('button') resolved to 4 elements:
  - <button>Save</button>
  - <button>Cancel</button>
  - <button>Settings</button>
  - <button>Help</button>
```

Fix:

```ts
await page.getByRole('button', { name: 'Save' }).click();
```

## Anti-patterns

| Don't                                                                 | Do                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `page.locator('.bg-purple-500.flex.items-center')` (Tailwind classes) | `page.getByRole('button', { name: 'Save' })`                                    |
| `page.locator('div > div > div > span')` (deep CSS)                   | `page.getByText('...')` or `getByTestId`                                        |
| `page.locator('button:nth-child(3)')` (index without filter)          | `page.getByRole('button', { name: 'X' })` or `.filter().first()`                |
| `page.locator('button').first()` (matches anything)                   | `page.getByRole('button', { name: 'X' })`                                       |
| `page.getByText('Save')` when "Save" and "Save & Close" both exist    | `getByText('Save', { exact: true })` or `getByRole('button', { name: 'Save' })` |
| Long XPath compounds when `getByRole` exists                          | `getByRole` first                                                               |

## Quick reference: roles you'll use

| HTML                         | Default role                             |
| ---------------------------- | ---------------------------------------- |
| `<button>`                   | button                                   |
| `<a href>`                   | link                                     |
| `<input type="text">`        | textbox                                  |
| `<input type="checkbox">`    | checkbox                                 |
| `<input type="radio">`       | radio                                    |
| `<input type="submit">`      | button                                   |
| `<input type="search">`      | searchbox                                |
| `<select>`                   | combobox                                 |
| `<select multiple>`          | listbox                                  |
| `<option>`                   | option                                   |
| `<textarea>`                 | textbox                                  |
| `<h1>`–`<h6>`                | heading                                  |
| `<nav>`                      | navigation                               |
| `<main>`                     | main                                     |
| `<aside>`                    | complementary                            |
| `<header>`                   | banner                                   |
| `<footer>`                   | contentinfo                              |
| `<dialog>` (`role="dialog"`) | dialog                                   |
| `<table>`                    | table                                    |
| `<tr>`                       | row                                      |
| `<td>`/`<th>`                | cell / columnheader                      |
| `<ul>`/`<ol>`                | list                                     |
| `<li>`                       | listitem                                 |
| `<form>`                     | form                                     |
| `<fieldset>`                 | group                                    |
| `<details>`/`<summary>`      | group                                    |
| `<svg>` (decorative)         | (none — use `[role="img"]` if focusable) |

For ARIA-tabbed UI: `role="tab"`, `role="tabpanel"`, `role="tablist"`. A settings screen's tabs use `role="tab"` correctly.
