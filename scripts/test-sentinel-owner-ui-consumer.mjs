#!/usr/bin/env node
// The installed surface consumer: genuine npm-installed public executables (farsight serve, farsight-sentinel serve and
// owner-ui) and a browser driving the Sentinel view — Scan there, confirmed in the paired owner frame, the scan, a
// stage and both report downloads read there, after the source is gone. Playwright is only this verifier's browser
// dependency.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { npmConsumer } from './npm-consumer.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  version = JSON.parse(readFileSync(join(root, 'packages/sentinel/package.json'))).version;
const c = await npmConsumer('sentinel-owner-ui-', [
  resolve(process.argv[2] ?? join(root, 'build/sentinel', `farsight-sentinel-${version}.tgz`)),
  resolve(
    process.argv[3] ??
      join(root, 'build', `farsight-cli-${JSON.parse(readFileSync(join(root, 'package.json'))).version}.tgz`),
  ),
]);
const children = new Set(),
  wait = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
const evidence = process.env.SENTINEL_OWNER_UI_EVIDENCE;
try {
  const ws = join(realpathSync.native(c.scratch), 'workspace'),
    source = join(ws, 'src');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'invoice.ts'),
    'export const lookup = id => db.query("SELECT * FROM invoices WHERE id="+id);\n',
  );
  const env = {
      ...c.env,
      XDG_STATE_HOME: join(realpathSync.native(c.scratch), 'owner-state'),
      XDG_CONFIG_HOME: join(realpathSync.native(c.scratch), 'owner-config'),
      NODE_PATH: '',
      NODE_OPTIONS: '',
    },
    bin = c.bin('farsight-sentinel');
  const owner = async (...args) => {
    try {
      return JSON.parse((await c.exec(bin, [...args, '--json'], { cwd: ws, env, timeout: 30000 })).stdout);
    } catch (e) {
      if (typeof e.code === 'number' && e.stdout) return JSON.parse(e.stdout);
      throw e;
    }
  };
  for (const args of [
    ['init'],
    ['settings', 'adopt', '--confirm'],
    ['rules', 'promote', join(c.dir, 'node_modules/farsight-sentinel/rules/foundation-preview'), '--confirm'],
  ]) {
    const value = await owner(...args);
    assert.equal(value.outcome, 'prepared', JSON.stringify({ step: args[0], value }));
  }
  let log = '';
  const launch = (file, args) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.stdout.on('data', (b) => (log = (log + b).slice(-16000)));
    child.stderr.on('data', (b) => (log = (log + b).slice(-16000)));
    return child;
  };
  launch(bin, ['serve', '--workspace', ws, '--idle-ms', '0']);
  const services = join(env.XDG_STATE_HOME, 'farsight/sentinel/trust/services');
  for (let i = 0; i < 1000; i++) {
    try {
      if (readdirSync(services).some((n) => n.endsWith('.json'))) break;
    } catch {}
    assert.ok(i < 999, log);
    await wait(20);
  }
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const origin = `http://127.0.0.1:${port}`,
    graph = join(ws, 'owner-graph.json');
  await c.exec(c.bin('farsight'), ['ingest', source, '--repo', 'original-owner-fixture', '--out', graph], {
    cwd: ws,
    env,
  });
  launch(c.bin('farsight'), ['serve', graph, '--port', String(port)]);
  for (let i = 0; i < 1000; i++) {
    try {
      const v = await (await fetch(origin + '/api/version')).json();
      if (v.session?.instance) break;
    } catch {}
    assert.ok(i < 999, log);
    await wait(20);
  }
  assert.equal((await (await fetch(origin + '/api/sentinel/companion')).json()).available, false);
  launch(bin, ['owner-ui', '--workspace', ws, '--farsight-origin', origin]);
  for (let i = 0; i < 1000; i++) {
    const v = await (await fetch(origin + '/api/sentinel/companion')).json();
    if (v.available) {
      assert.deepEqual(Object.keys(v).sort(), ['available', 'ownerOrigin']);
      break;
    }
    assert.ok(i < 999, log);
    await wait(20);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage(),
    errors = [],
    requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) requests.push({ status: r.status(), url: r.url() });
  });
  // The read pass the paired frame hands its parent (transport/http/): captured here, as the viewer will use it.
  await page.addInitScript(() => {
    globalThis.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'sentinel-owner-read')
        globalThis.__sentinelRead = { pass: e.data.pass, origin: e.origin };
    });
  });
  // The Sentinel view: Scan there, confirmed in the paired owner frame (the only place that confirms), read there.
  await page.goto(origin + '/#/sentinel');
  const frame = page.frameLocator('iframe[title="Sentinel"]'),
    scanButton = page.locator('.snt-tools .snt-scan'),
    confirmControl = frame.getByRole('button', { name: 'Confirm this run action', exact: true });
  await page.locator('.snt-tabs [data-tab="owner"]').click();
  await frame.getByText('Confirm here what you start from Sentinel.', { exact: true }).waitFor({ timeout: 15000 });
  for (const gone of ['Preview fresh capture', 'Refresh retained state', 'Read shareable report'])
    assert.equal(await frame.getByRole('button', { name: gone, exact: true }).count(), 0, gone);
  for (let i = 0; i < 150 && (await scanButton.getAttribute('aria-disabled')) === 'true'; i++) await wait(100);
  assert.equal(await scanButton.getAttribute('aria-disabled'), null, 'the installed view may start a scan');
  await scanButton.click();
  await frame.getByRole('button', { name: 'Confirm preparation', exact: true }).click();
  await confirmControl.waitFor({ timeout: 30000 });
  rmSync(source, { recursive: true });
  await confirmControl.click();
  await frame.getByText('Action accepted. Retained status is shown below.', { exact: true }).waitFor();
  // The view's ladder, a stage and the report, with the source gone.
  const scanId = await page.evaluate(async () => {
    const read = globalThis.__sentinelRead;
    for (let i = 0; i < 300; i++) {
      const r = await fetch(read.origin + '/api/sentinel/scans', { headers: { authorization: 'Bearer ' + read.pass } });
      const done = (await r.json()).scans?.find((s) => s.state === 'completed');
      if (done) return done.id;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  });
  assert.ok(scanId, 'the scan completed');
  await page.goto(origin + '/#/sentinel/' + encodeURIComponent(scanId));
  await page.locator('.snt-card').first().waitFor({ timeout: 15000 });
  assert.ok((await page.locator('.snt-card').count()) >= 4);
  await page.locator('.snt-tabs [data-tab="stage"]').click();
  await page.locator('.snt-dock').getByRole('link', { name: 'Open the stage' }).click();
  await page.locator('.snt[data-stop="stage"] .snt-stage').waitFor();
  assert.equal(await page.locator('.snt-stage .snt-empty.err').count(), 0);
  await page.locator('.snt-dock').getByRole('link', { name: 'Back to the pipeline' }).click();
  const downloads = {};
  for (const [format, label] of [
    ['html', 'Report · HTML'],
    ['md', 'Report · Markdown'],
  ]) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.snt-tools').getByRole('button', { name: label }).click(),
    ]);
    assert.match(download.suggestedFilename(), new RegExp('^sentinel-scan-\\d+\\.' + format + '$'));
    downloads[format] = readFileSync(await download.path(), 'utf8');
  }
  const report = downloads.md;
  assert.ok(report.length > 100 && downloads.html.length > 100);
  // A delivery is checked against the digest the companion sends with it (each reading is its own delivery).
  const delivered = await page.evaluate(async (id) => {
    const read = globalThis.__sentinelRead;
    const r = await fetch(read.origin + '/api/sentinel/scans/' + encodeURIComponent(id) + '/report/md', {
      headers: { authorization: 'Bearer ' + read.pass },
    });
    return { text: await r.text(), digest: r.headers.get('x-sentinel-format-digest') };
  }, scanId);
  const digest = delivered.digest;
  assert.equal(digest, 'sha256:' + createHash('sha256').update(delivered.text).digest('hex'));
  // The read model, read cross-origin from the Farsight page with that pass: the installed companion's own answers.
  const model = await page.evaluate(async () => {
    const read = globalThis.__sentinelRead;
    if (!read) return null;
    const get = async (path) => {
      const r = await fetch(read.origin + path, { headers: { authorization: 'Bearer ' + read.pass } });
      return {
        status: r.status,
        body: r.headers.get('content-type')?.startsWith('application/json') ? await r.json() : await r.text(),
      };
    };
    const scans = await get('/api/sentinel/scans');
    const id = scans.body.scans?.find((s) => s.state === 'completed')?.id;
    const at = '/api/sentinel/scans/' + encodeURIComponent(id);
    const scan = await get(at);
    const last = scan.body.stages?.at(-1)?.id;
    const unit = await get(at + '/stages/' + encodeURIComponent(last) + '/units/1');
    return { id, scans, scan, unit };
  });
  assert.ok(model, 'the paired frame handed its parent a read pass');
  assert.equal(model.scans.status, 200);
  assert.equal(model.scan.status, 200);
  assert.equal(model.unit.status, 200);
  assert.ok(model.scan.body.stages.length >= 4);
  assert.ok(model.scan.body.stages.every((s) => s.status === 'done'));
  assert.equal(model.unit.body.schema, 'sentinel-viewer-unit/draft-1');
  // A scan is addressed by its run id; no other run id leaves the read model's own fields (retained text is the
  // record as kept, verbatim, to the paired owner only).
  const fields = JSON.stringify(model, (k, v) => (k === 'text' && typeof v === 'string' ? '<retained>' : v));
  assert.doesNotMatch(fields.split(model.id).join('<run>'), /run-[0-9a-f]{8}/);
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'report.md'), report);
    await page.screenshot({ path: join(evidence, 'installed-completed.png'), fullPage: true });
  }
  // Reconnect: a reload re-pairs the frame from its owner-origin reload token, and the view reads again.
  await page.reload();
  await page.locator('.snt-tabs [data-tab="owner"]').click();
  await frame.getByText('Confirm here what you start from Sentinel.', { exact: true }).waitFor({ timeout: 15000 });
  await page.locator('.snt-card').first().waitFor({ timeout: 15000 });
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const result = {
    installedNpmOnly: true,
    noCheckoutRuntimeImports: true,
    sourceGone: true,
    scanFromTheView: true,
    confirmedInTheFrame: true,
    checksStartedSeparately: true,
    viewReadsScanAndStage: true,
    reportDownloads: ['html', 'md'],
    reportFormatDigest: digest,
    reconnect: true,
    readModel: true,
    errors,
    requests,
  };
  if (evidence) writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), wait(4000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  c.cleanup();
}
