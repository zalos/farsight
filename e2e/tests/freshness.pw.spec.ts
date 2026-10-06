// *Stale* said once and only when true (swarm-fixes 2026-10-05, finding 2): a journey whose runs are
// current says so with its sync, and a stale one says what it is stale against — the run's commit and
// the code's — on the header and on the evidence chip's tip. The fixture's reports are stamped and its
// digests match, so the current case is the real graph; the stale case rewrites one /api/journey answer
// with page.route (ADR 8: faults by route, never a mock server) to a run on an older commit.
import { test, expect, openBillingCycle } from './support';

const RAN = 'ffe27594072f52c91af36314d4f0302d3b52c0b0';
const NOW = '4632734fc9ac27c228eabdf63b92863283fad0a2';

test.describe('freshness', () => {
  /**
   * @covers packages/server/public/app/lib/freshness.js::freshLineHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnHeaderHtml
   * @covers GET /api/journey
   */
  test('a current journey says current, with the sync it holds for', async ({ page }) => {
    await openBillingCycle(page);
    const line = page.locator('#journey .jrn-fresh').first();
    await expect(line).toBeVisible();
    await expect(line).toHaveText(/^current as of sync \d+ — the tests ran on the code as it is now$/);
    await expect(page.locator('#journey .jrn-e2e')).not.toHaveText(/stale/i);
  });

  /**
   * @covers packages/server/public/app/lib/freshness.js::freshTipHtml
   * @covers packages/server/public/app/surfaces/journeys.js::jrnEvidenceTip
   */
  test('a stale journey names both sides — on the header and in the chip tip', async ({ page }) => {
    await page.route(/\/api\/journey\?/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const j = body.summary && body.summary.coverage && body.summary.coverage.journey;
      if (j && j.chip && j.chip.startsWith('observed')) {
        j.chip = 'observed-stale';
        j.evidenceWord = { cls: 'stale', key: 'journey.evidence.stale', biz: 'journey.biz.testsRun.stale' };
        j.freshness = {
          state: 'stale', ranAt: '2026-10-04T15:17:53.461Z', ranOn: { commit: RAN }, codeAt: { commit: NOW, sync: 106 },
          changedBy: 'commit', runs: { current: 0, stale: 3, noDigest: 0 },
          word: 'fresh.state.stale', key: 'fresh.sentence.staleCommit', biz: 'journey.biz.fresh.stale', recipe: 'fresh.recipe.rerun',
        };
      }
      await route.fulfill({ response: res, json: body });
    });
    await openBillingCycle(page);
    const sentence = 'stale — the tests ran on commit ffe2759 (2026-10-04); the code is at commit 4632734 now';
    await expect(page.locator('#journey .jrn-fresh').first()).toHaveText(sentence);
    // the chip's tip carries the same sentence beside the run behind the word
    await page.locator('#journey .jrn-e2e').first().click();
    const tip = page.locator('#fs-tip');
    await expect(tip).toContainText(sentence);
  });
});
