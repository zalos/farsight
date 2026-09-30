# Page Objects

Playwright has first-class support for the Page Object Model. Combined with fixtures, you get a clean DI pattern with no singletons.

## Why POM

- **Single source of truth** for selectors per page — change once, ripple through every test
- **Domain language** in tests — `await sessionsPage.archive(name)` reads better than three locator + click lines
- **Encapsulates wait logic** — `await sessionsPage.waitUntilLoaded()` hides the implementation
- **Easier to mock** — fixture-injected POMs swap in fakes for isolated tests

## Class skeleton

```ts
// e2e/pages/SessionsPage.ts
import { type Page, type Locator, expect } from '@playwright/test';

export class SessionsPage {
  readonly page: Page;
  readonly newSessionButton: Locator;
  readonly searchInput: Locator;
  readonly sessionsTable: Locator;

  constructor(page: Page) {
    this.page = page;
    this.newSessionButton = page.getByRole('button', { name: 'New session' });
    this.searchInput = page.getByPlaceholder('Search sessions');
    this.sessionsTable = page.getByRole('table', { name: /sessions/i });
  }

  async goto() {
    await this.page.getByRole('link', { name: 'Sessions' }).click();
    await expect(this.page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  }

  rowFor(name: string): Locator {
    return this.sessionsTable.getByRole('row').filter({ hasText: name });
  }

  async archive(name: string) {
    const row = this.rowFor(name);
    await row.getByRole('button', { name: 'Archive' }).click();
    await this.page.getByRole('button', { name: 'Confirm' }).click();
    await expect(row).toBeHidden();
  }

  async expectCount(n: number) {
    await expect(this.sessionsTable.getByRole('row')).toHaveCount(n + 1); // +1 header
  }
}
```

## Lazy vs eager locators

Playwright Locators are **lazy** — they don't query until awaited. So storing them in `constructor` is safe (no premature DOM read).

```ts
// ✓ Eager assignment in constructor — no DOM access yet
this.newSessionButton = page.getByRole('button', { name: 'New session' });

// Action queries the DOM:
await this.newSessionButton.click();
```

This is different from WDIO where `$()` returned a chainable promise — getter functions were idiomatic. **Don't write getters in Playwright POMs**, just constructor-assigned locators.

## Inject via a fixture

```ts
// e2e/fixtures.ts
import { test as base } from '@playwright/test';
import { SessionsPage } from './pages/SessionsPage';
import { WorkPage } from './pages/WorkPage';
import { SettingsPage } from './pages/SettingsPage';

type Pages = {
  sessionsPage: SessionsPage;
  workPage: WorkPage;
  settingsPage: SettingsPage;
};

export const test = base.extend<Pages>({
  sessionsPage: async ({ page }, use) => use(new SessionsPage(page)),
  workPage: async ({ page }, use) => use(new WorkPage(page)),
  settingsPage: async ({ page }, use) => use(new SettingsPage(page)),
});

export { expect } from '@playwright/test';
```

Then in a spec:

```ts
import { test, expect } from './fixtures';

test('archive a session', async ({ sessionsPage }) => {
  await sessionsPage.goto();
  await sessionsPage.archive('Old session');
  await sessionsPage.expectCount(0);
});
```

## Folder structure

```
e2e/
  fixtures.ts
  pages/
    SessionsPage.ts
    WorkPage.ts
    SettingsPage.ts
    NotesPage.ts
    components/
      Sidebar.ts
      Toast.ts
      ContextPicker.ts
  helpers/
    pw.ts
    pw-screenshots.ts
    electronMock.ts
  smoke.pw.spec.ts
  sessions.pw.spec.ts
  ...
```

## Component objects

For widgets that appear on multiple pages (sidebar, toast, modal), make a **component object** that takes a `Locator` (the root) instead of a `Page`:

```ts
// e2e/pages/components/Sidebar.ts
export class Sidebar {
  constructor(public readonly root: Locator) {}
  link(name: string) {
    return this.root.getByRole('link', { name });
  }
  async navigate(name: string) {
    await this.link(name).click();
  }
}

// in a page:
get sidebar() { return new Sidebar(this.page.locator('aside')); }
```

## Inheritance for shared parts

Don't go wild — but a `BasePage` for `goto`/`waitForReady` is reasonable:

```ts
export abstract class BasePage {
  constructor(protected readonly page: Page) {}
  async waitForReady() {
    await expect(this.page.locator('#root')).toBeVisible();
  }
  abstract goto(): Promise<void>;
}

export class SessionsPage extends BasePage {
  async goto() {
    /* ... */
  }
}
```

## When NOT to POM

- **One-off interactions** (a single click in a single test) — overkill
- **Pure smoke tests** that just assert "thing renders" — use locators directly
- **Visual regression crawls** — the data-driven structure is its own pattern; POMs add noise

`e2e/helpers/pw.ts` is a flat helper module, NOT a POM. That pattern is fine for cross-cutting helpers (`waitForAppReady`, `freezeDynamicContent`) — keep those in `e2e/helpers/`. Reserve POMs for stateful UI surfaces with multiple actions per spec.

## Asserting from inside a POM

POMs can use `expect()` directly — they import from `@playwright/test`:

```ts
import { type Page, type Locator, expect } from '@playwright/test';

export class SessionsPage {
  // ...
  async expectArchived(name: string) {
    await expect(this.rowFor(name)).toBeHidden();
    await expect(this.page.getByTestId('toast')).toContainText('Archived');
  }
}
```

Many teams hold the rule "POMs do actions, specs do assertions" — that's fine for keeping concerns separate, but Playwright doesn't enforce it.

## Anti-patterns

| Don't                                                                            | Do                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Singleton/exported instance: `export const sessionsPage = new SessionsPage(...)` | Fixture-inject — one new POM per test                                     |
| `_locators: { newSession: () => ... }` (lazy getter)                             | Eager assignment in constructor — Locators are already lazy               |
| Long `waitForExist` chains in every method                                       | Action calls auto-wait; rely on that                                      |
| POM stores state (e.g. `this._lastClickedRow`)                                   | POMs are thin wrappers over a Page; state belongs in the test             |
| Calling `page.goto()` in the constructor                                         | Pages should not navigate on instantiation — provide an explicit `goto()` |
