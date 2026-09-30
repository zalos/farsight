// Stories (ADR 9): a component's stories come from its story file; a running
// Storybook only draws them. The fixture's CreateInvoiceForm has three stories
// (examples/invoice-app/src/ui/CreateInvoiceForm.stories.tsx). The server reads
// a Storybook's /index.json itself, so a browser-side page.route cannot stand in
// for it: this spec serves a small fake Storybook of its own on the port the
// fixture workspace points the source at (FARSIGHT_E2E_SB_PORT, default 4539) —
// absent first, to see the not-running state, then started, and "Check again"
// must find it without a reload.
import { createServer, type Server } from 'node:http';
import { test, expect, gotoReady } from './support';

const SB_PORT = Number(process.env['FARSIGHT_E2E_SB_PORT'] || 4539);
const SB_URL = `http://127.0.0.1:${SB_PORT}`;
const FORM = 'invoice-app::src/ui/CreateInvoiceForm.tsx::CreateInvoiceForm';
const FORM_HASH = '#/codemap?node=' + encodeURIComponent(FORM);

const entry = (id: string, name: string, type: 'story' | 'docs' = 'story', componentPath: string | undefined = './src/ui/CreateInvoiceForm.tsx', title = 'Invoices/CreateInvoiceForm') =>
  [id, { id, name, title, type, importPath: './src/ui/CreateInvoiceForm.stories.tsx', ...(componentPath ? { componentPath } : {}) }];
const INDEX = {
  v: 5,
  entries: Object.fromEntries([
    entry('invoices-createinvoiceform--empty', 'Empty'),
    entry('invoices-createinvoiceform--with-line-items', 'With line items'),
    entry('invoices-createinvoiceform--invalid', 'Invalid'),
    entry('invoices-createinvoiceform--docs', 'Docs', 'docs', undefined),
    // a story whose component file the graph does not hold: named, never guessed
    entry('invoices-ghost--default', 'Default', 'story', './src/ui/Ghost.tsx', 'Invoices/Ghost'),
  ]),
};

let sb: Server | null = null;
function startFakeStorybook(): Promise<void> {
  sb = createServer((req, res) => {
    const u = new URL(req.url ?? '/', SB_URL);
    if (u.pathname === '/index.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(INDEX)); return; }
    if (u.pathname === '/iframe.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body><h1 id="story">Story ${u.searchParams.get('id')} (${u.searchParams.get('viewMode')})</h1></body></html>`);
      return;
    }
    res.writeHead(204); res.end();
  });
  return new Promise((ok, fail) => { sb!.once('error', fail); sb!.listen(SB_PORT, '127.0.0.1', () => ok()); });
}

test.describe.configure({ mode: 'serial' });
test.afterAll(async () => { await new Promise<void>((ok) => (sb ? sb.close(() => ok()) : ok())); });

/**
 * @covers packages/server/public/app/stories.js::storiesSecHtml
 * GET /api/stories
 */
test('no Storybook running: the stories are listed by name and the section says how to start it', async ({ page }) => {
  await gotoReady(page, FORM_HASH);
  const sec = page.locator('#insp-stories');
  await expect(sec.getByRole('tab')).toHaveText(['Empty', 'With line items', 'Invalid']);
  await expect(sec).toContainText(`Storybook is not running at ${SB_URL}. Start it with npm run storybook`);
  await expect(sec).toContainText('not reached');
  await expect(sec.locator('iframe')).toHaveCount(0);
});

/**
 * @covers packages/server/public/app/stories.js::storiesRetry
 * @covers packages/server/public/app/stories.js::storyPick
 * @covers packages/server/public/app/stories.js::openStoryLightbox
 */
test('Storybook started: "Check again" frames the story, a tab switches it, and it opens large', async ({ page }) => {
  await startFakeStorybook();
  await gotoReady(page, FORM_HASH);
  const sec = page.locator('#insp-stories');
  // the viewer may still hold the not-running answer for a few seconds; the button asks again now
  await expect(sec.locator('iframe.sb-frame, .sb-retry').first()).toBeVisible();
  const retry = sec.getByRole('button', { name: 'Check again' });
  if (await retry.count()) await retry.click();
  const frame = sec.locator('iframe.sb-frame');
  await expect(frame).toHaveAttribute('src', `${SB_URL}/iframe.html?id=invoices-createinvoiceform--empty&viewMode=story`);
  await expect(page.frameLocator('#insp-stories iframe.sb-frame').locator('#story')).toHaveText('Story invoices-createinvoiceform--empty (story)');
  await sec.getByRole('tab', { name: 'With line items' }).click();
  await expect(sec.getByRole('tab', { name: 'With line items' })).toHaveAttribute('aria-selected', 'true');
  await expect(frame).toHaveAttribute('src', /id=invoices-createinvoiceform--with-line-items/);
  await expect(sec).toContainText('A customer picked and one line item filled in, ready to save.');
  // the docs page the running Storybook lists joins the tabs
  await expect(sec.getByRole('tab', { name: 'Docs page' })).toBeVisible();
  await sec.getByRole('button', { name: 'Open large' }).first().click();
  const large = page.getByRole('dialog', { name: /Stories · Create invoice form/ });
  await expect(large).toBeVisible();
  await expect(large.locator('iframe.sb-lb-frame')).toHaveAttribute('src', /id=invoices-createinvoiceform--with-line-items/);
  const box = await large.locator('iframe.sb-lb-frame').boundingBox();
  expect(box!.width).toBeGreaterThan(900); // images big: the large view is most of the window
  await page.keyboard.press('Escape');
  await expect(large).toHaveCount(0);
});

/**
 * @covers packages/server/public/app/stories.js::storiesSecHtml
 */
test('the business register names the stories and hides the file line', async ({ page }) => {
  await gotoReady(page, FORM_HASH + '&lens=business');
  const sec = page.locator('#insp-stories');
  await expect(sec.getByRole('tab', { name: 'With line items' })).toBeVisible();
  await expect(sec.locator('.sb-where')).toHaveCount(0);
  await gotoReady(page, FORM_HASH + '&lens=code');
  await expect(page.locator('#insp-stories .sb-where')).toContainText('src/ui/CreateInvoiceForm.stories.tsx:');
});

/**
 * @covers GET /api/stories
 */
test('/api/stories maps the index — by story id, the docs page by its title, the ghost named — and the page may frame only that origin', async ({ page, request }) => {
  const res = await request.get('/api/stories?refresh=1');
  const body = await res.json();
  const book = body.storybooks[0];
  expect(book.reachable).toBe(true);
  expect(book.counts).toEqual({ stories: 4, docs: 1, resolved: 4, unresolved: 1, via: { 'story-id': 3, 'docs-title': 1 } });
  expect(book.unresolved).toEqual([{ id: 'invoices-ghost--default', title: 'Invoices/Ghost', name: 'Default', type: 'story', path: 'src/ui/Ghost.tsx', reason: 'no-node-at-path' }]);
  expect(body.byNode[FORM].map((s: { id: string }) => s.id)).toEqual([
    'invoices-createinvoiceform--empty', 'invoices-createinvoiceform--with-line-items', 'invoices-createinvoiceform--invalid', 'invoices-createinvoiceform--docs',
  ]);
  const page0 = await request.get('/');
  expect(page0.headers()['content-security-policy']).toBe(`frame-src 'self' ${SB_URL}`);
  void page;
});

/**
 * @covers packages/server/public/app/stories.js::storiesCatalogueHtml
 * @covers packages/server/public/app/stories.js::storyChipsHtml
 */
test('the front door lists what can be seen on its own, and a journey screen carries a story chip', async ({ page }) => {
  await gotoReady(page, '#/portfolio');
  const cat = page.locator('#sb-cat');
  await expect(cat).toContainText('Invoice app UI');
  await expect(cat).toContainText('Storybook running');
  // the index's entries are stories and docs pages: the words name both (docs/COUNTS.md)
  await expect(cat).toContainText('4 of 5 stories and docs pages matched a component');
  await cat.getByRole('button', { name: /Create invoice form/ }).click();
  await expect(page.getByRole('dialog', { name: /Stories · Create invoice form/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await gotoReady(page, '#/journeys/' + encodeURIComponent('invoice-app::flow::billing-cycle') + '?lens=business');
  const chip = page.locator('.jrn-scene .sb-chip').first();
  await expect(chip).toContainText('Create invoice form · 3 stories');
  await chip.click();
  await expect(page.getByRole('dialog', { name: /Stories · Create invoice form/ })).toBeVisible();
});
