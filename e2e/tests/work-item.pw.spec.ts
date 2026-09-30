// One work item's pane: the edits post the right intents and the page draws the
// gate's answer as what it is — applied, waiting for a person, a conflict, or
// denied with its three verdicts — and what the work changed, down to the diff.
import { test, expect } from './support';
import { routeWork, routeWorkSettings, WorkStub } from './work-stub';

const itemHash = (key: string, src = 'invoice-jira') => '/#/work/' + encodeURIComponent(`work::${src}::${key}`);

test.describe('work item pane', () => {
  let stub: WorkStub;
  test.beforeEach(async ({ page }) => {
    await routeWorkSettings(page);
    stub = await routeWork(page);
  });

  /**
   * @covers packages/server/public/app/surfaces/work.js::workComment
   * @covers POST /api/work/intent
   */
  test('a comment posts a comment intent and the applied answer shows the tracker’s copy', async ({ page }) => {
    await page.goto(itemHash('INV-3'));
    await expect(page.locator('.wk-pane')).toBeVisible();
    await page.locator('#wk-comment-in').fill('Sorted **newest** first in the service.');
    await page.getByRole('button', { name: 'post comment' }).click();
    await expect(page.locator('.wk-ans[data-status="applied"]')).toBeVisible();
    const post = stub.posts.find((p) => p.path === '/api/work/intent');
    expect(post?.body).toMatchObject({ item: 'work::invoice-jira::INV-3', action: 'comment', payload: { body: 'Sorted **newest** first in the service.' }, requestedBy: { kind: 'human' } });
    expect(post?.body.baseRevision).toBeTruthy();
    // the markdown is rendered, never printed as asterisks
    await expect(page.locator('.wk-comment').last().locator('.wk-md b')).toHaveText('newest');
  });

  /**
   * @covers packages/server/public/app/surfaces/work.js::workAssign
   * @covers packages/server/public/app/surfaces/work.js::workSettle
   */
  test('assign picks from the people list, waits for confirmation, and applies on confirm', async ({ page }) => {
    await page.goto(itemHash('INV-5'));
    await page.locator('button[data-action="assign"]').click();
    await page.locator('.wk-pick button[data-person="5b10ac8d82e05b22cc7d4ef5"]').click();
    const pending = page.locator('#wk-answers .wk-ans[data-status="pending"]').first();
    await expect(pending).toContainText('waiting for your confirmation');
    await expect(pending).toContainText('Ben Lindqvist');
    expect(stub.posts.at(-1)?.body).toMatchObject({ action: 'assign', payload: { assignee: '5b10ac8d82e05b22cc7d4ef5' } });
    await pending.getByRole('button', { name: 'confirm' }).click();
    await expect(page.locator('#wk-answers .wk-ans[data-status="applied"]')).toBeVisible();
    expect(stub.posts.at(-1)?.path).toMatch(/\/api\/work\/intent\/int-\d+\/confirm$/);
    await expect(page.locator('.wk-facts')).toContainText('Ben Lindqvist');
  });

  /** @covers packages/server/public/app/surfaces/work.js::verdictsHtml */
  test('a move the tracker refuses is denied, with all three verdicts printed', async ({ page }) => {
    await page.goto(itemHash('INV-8'));
    await page.locator('button[data-action="transition"]').click();
    await page.locator('.wk-pick button[data-state="In Progress"]').click();
    const denied = page.locator('.wk-ans[data-status="denied"]');
    await expect(denied).toContainText('not allowed: nothing was written');
    await expect(denied.locator('[data-verdict]')).toHaveCount(3);
    await expect(denied.locator('[data-verdict="work.hud.ans.policy"]')).toContainText('your policy says');
    await expect(denied.locator('[data-verdict="work.hud.ans.tracker"]')).toContainText('Jira says: the workflow has no transition out of Done');
    await expect(denied.locator('[data-verdict="work.hud.ans.tracker"] .yn')).toHaveText('no');
    await expect(denied.locator('[data-verdict="work.hud.ans.credential"]')).toContainText('the credential can');
    expect(stub.posts.at(-1)?.body).toMatchObject({ action: 'transition', payload: { to: 'In Progress' } });
    // nothing moved
    await expect(page.locator('.wk-facts .wk-state')).toContainText('done');
  });

  /** @covers packages/server/public/app/surfaces/work.js::answerHtml */
  test('an edit over a changed item is a conflict: the tracker’s version beside the ask, then re-base', async ({ page }) => {
    await page.goto(itemHash('INV-9'));
    await page.locator('button[data-action="edit"]').first().click();
    await page.locator('#wk-title-in').fill('Email the customer a copy when an invoice is sent');
    await page.getByRole('button', { name: 'save' }).click();
    const conflict = page.locator('.wk-ans[data-status="conflict"]').first();
    await expect(conflict).toContainText('the tracker changed since your copy');
    await expect(conflict.locator('[data-side="theirs"]')).toContainText('(edited in Jira)');
    await expect(conflict.locator('[data-side="yours"]')).toContainText('Email the customer a copy');
    expect(stub.posts.at(-1)?.body).toMatchObject({ action: 'edit', payload: { title: 'Email the customer a copy when an invoice is sent' } });
    await conflict.getByRole('button', { name: 're-base' }).click();
    await expect(page.locator('.wk-ans[data-status="applied"]')).toBeVisible();
    await expect(page.locator('#wk-title')).toHaveText('Email the customer a copy when an invoice is sent');
  });

  /** @covers packages/server/public/app/surfaces/work.js::seedWaiting */
  test('an agent’s comment waiting in the outbox shows on its item, and drop forgets it', async ({ page }) => {
    await page.goto(itemHash('INV-6'));
    const waiting = page.locator('.wk-ans[data-status="pending"]');
    await expect(waiting).toContainText('asked by an agent');
    // the comment an agent already wrote carries its attribution line
    await expect(page.locator('.wk-comment .wk-attrib')).toContainText('written by an agent through Farsight');
    await waiting.getByRole('button', { name: 'drop' }).click();
    await expect(page.locator('.wk-ans[data-status="dropped"]')).toBeVisible();
    expect(stub.posts.at(-1)?.path).toMatch(/int-0007\/drop$/);
  });

  /**
   * @covers packages/server/public/app/surfaces/work.js::workDiff
   * @covers GET /api/work/item/:id/diff
   */
  test('a commit opens to its diff, and a touched part travels to the code map', async ({ page }) => {
    await page.goto(itemHash('INV-2'));
    await expect(page.locator('#wk-changed')).toContainText('5 parts touched');
    const commit = page.locator('.wk-commit[data-sha="a1c9e02"]');
    await expect(commit).toContainText('named in the subject');
    await commit.getByRole('button', { name: 'show the change' }).click();
    const file = commit.locator('.wk-dfile[data-path="src/ui/CreateInvoiceForm.tsx"]');
    await expect(file.locator('.wk-patch .add')).toHaveCount(4);
    await expect(file.locator('.wk-patch .del')).toHaveCount(1);
    await expect(file.locator('.wk-patch .hunk')).toHaveCount(1);
    await file.locator('.wk-node[data-node="invoice-app::src/ui/CreateInvoiceForm.tsx::submit"]').click();
    await expect(page).toHaveURL(/#\/codemap\?node=/);
    await expect(page.locator('#inspector')).toContainText('submit');
  });

  /** @covers packages/server/public/app/surfaces/work.js::findingsHtml */
  test('findings print both provenances; a declared link says how sure it is', async ({ page }) => {
    await page.goto(itemHash('INV-5'));
    const f = page.locator('.wk-finding[data-kind="todo-but-committed"]');
    await expect(f).toContainText('to do, but committed');
    await expect(f).toContainText('the tracker says: INV-5 is To Do');
    await expect(f).toContainText('the code says: commit c07d2b9 names INV-5');
    await page.goto(itemHash('INV-2'));
    await expect(page.locator('[data-link="invoice-app::page::/invoices/new"]')).toContainText('certain');
  });

  /** @covers packages/server/public/app/surfaces/work.js::previewBtn */
  test('only a source that can check a write offers preview, and a preview writes nothing', async ({ page }) => {
    await page.goto(itemHash('INV-3'));
    await expect(page.locator('#wk-comment-in')).toBeVisible();
    await expect(page.locator('[data-preview]')).toHaveCount(0);
    stub.sources[1].mode = 'edit';
    await page.goto(itemHash('4712', 'invoice-azdo'));
    await expect(page.locator('.wk-undef')).toContainText('not a state its type defines');
    await page.locator('#wk-comment-in').fill('Checked on staging.');
    await page.locator('[data-preview]').click();
    await expect(page.locator('.wk-ans[data-status="previewed"]')).toBeVisible();
    await expect(page.locator('[data-preview-answer="ok"]')).toHaveText('dry run: ok');
    expect(stub.posts.at(-1)?.body).toMatchObject({ action: 'comment', dryRun: true });
    await expect(page.locator('.wk-comment')).toHaveCount(0);
  });
});
