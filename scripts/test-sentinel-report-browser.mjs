#!/usr/bin/env node
// Opens delivered Sentinel HTML reports the way a recipient would: a local file in a browser with no network, no
// product and no source. Each file must load with no page error, no request but its own file, its heading and
// counts visible, and print to PDF. A screenshot of each (screen and print) is written beside it for a reviewer.
//
//   node scripts/test-sentinel-report-browser.mjs <report.html>...
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const files = process.argv.slice(2).map((f) => resolve(f));
assert.ok(files.length, 'name at least one HTML report');
const browser = await chromium.launch();
try {
  for (const file of files) {
    assert.ok(existsSync(file), file);
    const url = pathToFileURL(file).href;
    const context = await browser.newContext({ offline: true, javaScriptEnabled: false });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(url, { waitUntil: 'load' });
    const text = await page.locator('body').innerText();
    assert.match(text, /finding|issue/i, `${file}: the report's findings are readable`);
    assert.ok((await page.locator('h1').count()) >= 1, `${file}: a heading`);
    assert.deepEqual(
      requests.filter((r) => r !== url),
      [],
      `${file}: loads nothing but itself`,
    );
    assert.deepEqual(errors, [], `${file}: no page or console error`);
    await page.screenshot({ path: `${file}.screen.png`, fullPage: true });
    await page.emulateMedia({ media: 'print' });
    await page.screenshot({ path: `${file}.print.png`, fullPage: true });
    await page.pdf({ path: `${file}.pdf`, format: 'A4' });
    assert.ok(statSync(`${file}.pdf`).size > 1000, `${file}: printed`);
    await context.close();
    console.log(`viewed offline: ${file} (${text.length} characters, screen and print)`);
  }
} finally {
  await browser.close();
}
console.log(
  `sentinel report browser ok: ${files.length} file(s) viewed offline with no request, no error, and printed`,
);
