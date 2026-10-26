// Real accepted structural delivery, then no workspace/store, JavaScript or network. The withheld projection is
// separately qualified against genuine native scanner ancestry in path-report-secrets.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathOwnerFixture } from './path-owner-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { openStore } from '../dist/store/index.js';
import { runPlan } from '../dist/service/local.js';
import { fullReport, withholdSecretRun } from '../dist/service/full-report.js';
import { renderHtml } from '../dist/reports/html.js';
const browserOnly =
  process.env.SENTINEL_REPORT_BROWSER === '1'
    ? needsStore
    : { skip: 'set SENTINEL_REPORT_BROWSER=1 for offline delivered structural HTML and printing' };
test(
  'accepted structural reports remain readable and printable offline without JavaScript, source or store',
  browserOnly,
  async (t) => {
    const f = await pathOwnerFixture(t),
      prepared: any = await f.call(true),
      id = prepared.facts.runId;
    assert.equal((await runPlan(f.ws, { planId: id, confirm: true, now: new Date() })).facts.state, 'completed');
    const store = await openStore(f.ws.storePath);
    let clean: any;
    try {
      clean = await fullReport({
        store,
        runId: id,
        workspace: f.path,
        trustDir: f.ws.trustDir,
        disclosure: 'private',
        now: new Date(),
      });
    } finally {
      store.close();
    }
    const out = join(f.dir, 'delivered');
    mkdirSync(out);
    writeFileSync(join(out, 'clean.html'), clean.html);
    writeFileSync(join(out, 'withheld.html'), renderHtml(withholdSecretRun(clean.document, new Map())));
    rmSync(f.path, { recursive: true, force: true });
    const { chromium } = await import('@playwright/test'),
      browser = await chromium.launch();
    t.after(() => browser.close());
    for (const name of ['clean', 'withheld']) {
      const context = await browser.newContext({ javaScriptEnabled: false, offline: true }),
        requests: string[] = [],
        errors: string[] = [];
      context.on('request', (r) => requests.push(r.url()));
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      const url = pathToFileURL(join(out, name + '.html')).href;
      await page.goto(url);
      const text = await page.locator('main').innerText();
      assert.match(text, /Structural call reachability/);
      assert.match(text, /reported by the pinned bounded query/);
      assert.match(text, /recorded call path was found/);
      if (name === 'clean') assert.match(text, /workspace::src\/routes.ts::getUser/);
      else {
        assert.equal(text.includes('workspace::src/routes.ts::getUser'), false);
        assert.match(text, /withheld/);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, [url]);
      const first = await page.locator('nav a').first().getAttribute('href');
      await page.click(`nav a[href="${first}"]`);
      assert.ok(page.url().endsWith(first!));
      if (process.env.SENTINEL_REPORT_SHOTS)
        await page.screenshot({ path: join(process.env.SENTINEL_REPORT_SHOTS, `paths-${name}.png`), fullPage: true });
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.locator('nav').isVisible(), false);
      assert.ok((await page.pdf({ format: 'A4' })).length > 1000);
      assert.deepEqual(requests, [url]);
      await context.close();
    }
  },
);
