// Actual browser → paired Farsight host → companion → production socket → owner service (lane L-UX U-3): the PIPELINE
// stop's edit mode edits a stage in the page, Check hands the edited pipeline to the real owner frame, the frame's own
// confirmation writes exactly those bytes on its settings.adopt receipt, and the page reads the file back as changed,
// not adopted. Gated like owner-ui-browser.test.ts: it starts Farsight's server and a headless browser.
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { OwnerService } from '../dist/service/owner-service.js';
import { listenOwnerSocket, runtimeAddress, newOwnerNonce } from '../dist/transport/ipc.js';
import { writePrivateFileAtomic } from '../dist/policy/user-state.js';
import { loadPipeline } from '../dist/app/pipeline-adoption.js';
import { startOwnerUi } from '../dist/owner-ui/server.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';
const cli = fileURLToPath(new URL('../../cli/dist/cli.js', import.meta.url)),
  port = Number(process.env.SENTINEL_OWNER_UI_STAGE_PORT ?? 4586),
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  'the page edits a stage, the real owner frame checks it and writes it on its own confirmation; nothing is adopted',
  {
    ...needsStore,
    skip:
      process.env.SENTINEL_OWNER_UI_BROWSER !== '1'
        ? 'explicit SENTINEL_OWNER_UI_BROWSER=1 browser gate'
        : needsStore.skip,
    timeout: 90000,
  },
  async (t) => {
    try {
      const occupied = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
      assert.equal(occupied.trim(), '', 'owned browser port occupied');
    } catch (e: any) {
      if (e.status !== 1) throw e;
    }
    const f = await preparationFixture(t),
      oldState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(f.dir, 'owner');
    const service = new OwnerService(f.store, f.ws, { registry: f.registry }),
      nonce = newOwnerNonce(),
      address = runtimeAddress({ storePath: f.store.storePath, ownerNonce: nonce, sources: [f.ws.path] });
    let child: ReturnType<typeof spawn> | undefined,
      companion: Awaited<ReturnType<typeof startOwnerUi>> | undefined,
      browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const socket = await listenOwnerSocket(
      address,
      { storeId: f.store.storeId, ownerNonce: nonce },
      (op, body, by, context) => service.handle(op, body, by, context),
    );
    writePrivateFileAtomic(
      join(f.ws.trustDir, 'services'),
      createHash('sha256').update(f.ws.storePath).digest('hex').slice(0, 32) + '.json',
      Buffer.from(
        JSON.stringify({
          schema: 'sentinel-service/draft-1',
          storePath: f.ws.storePath,
          storeId: f.store.storeId,
          ownerNonce: nonce,
          address,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      ),
      'sentinel.receipt.storeUnsafe',
    );
    const evidence =
      process.env.SENTINEL_OWNER_UI_EVIDENCE ?? join(tmpdir(), 'owner-ui-stage-' + process.pid + '-' + Date.now());
    const errors: string[] = [],
      consoleErrors: string[] = [],
      http: any[] = [];
    const path = join(f.ws.path, '.farsight', 'sentinel', 'pipeline.json');
    try {
      mkdirSync(evidence, { recursive: true });
      const graph = join(f.dir, 'graph.json');
      execFileSync(process.execPath, [cli, 'ingest', f.ws.path, '--repo', 'original-owner-fixture', '--out', graph], {
        cwd: f.dir,
        env: process.env,
        timeout: 30000,
      });
      child = spawn(process.execPath, [cli, 'serve', graph, '--port', String(port)], {
        cwd: f.ws.path,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let logs = '';
      child.stderr?.on('data', (b) => (logs += b));
      child.stdout?.on('data', (b) => (logs += b));
      for (let i = 0; i < 200; i++) {
        try {
          const v: any = await (await fetch(`http://127.0.0.1:${port}/api/version`)).json();
          if (v.session?.instance) break;
        } catch {}
        if (child.exitCode !== null) assert.fail(logs);
        await wait(30);
      }
      companion = await startOwnerUi(f.ws, `http://127.0.0.1:${port}`);
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
        page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('response', (r) => {
        if (r.status() >= 400) http.push({ status: r.status(), url: r.url() });
      });
      const before = JSON.parse(readFileSync(path, 'utf8')),
        adopted = loadPipeline({ workspace: f.ws.path, trustDir: f.ws.trustDir, readOnly: true });
      await page.goto(`http://127.0.0.1:${port}/#/sentinel?edit=1&pick=report`);
      const frame = page.frameLocator('iframe[title="Sentinel"]');
      await frame.getByRole('button', { name: 'Preview fresh capture', exact: true }).waitFor({ timeout: 15000 });
      await page
        .locator('.snt-erow:not(.gone)')
        .nth(before.stages.length - 1)
        .waitFor();
      assert.equal(await page.locator('.snt-erow:not(.gone)').count(), before.stages.length);
      await page.screenshot({ path: join(evidence, 'edit-1440.png') });
      // A refusal through the real frame: an empty model stage is not a pipeline; nothing is written, no confirmation.
      await page.locator('.snt-eadd [data-enew="agent"]').click();
      await page.locator('.snt-tools [data-act="echeck"]').click();
      await page
        .locator('.snt-verdicts')
        .getByText(/the pipeline file is not a valid pipeline \(\/stages\/\d+: required: must have required property/)
        .waitFor({ timeout: 15000 });
      assert.equal(await frame.getByRole('button', { name: 'Confirm writing the pipeline', exact: true }).count(), 0);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), before);
      await page.locator('.snt-tools [data-act="ediscard"]').click();
      await page.locator('.snt-erow:not(.gone)', { hasText: 'report' }).click();
      await page.locator('.snt-dock [data-ebudget="seconds"]').waitFor();
      // The edit: the report stage gets a time ceiling, in the drawer.
      const seconds = page.locator('.snt-dock [data-ebudget="seconds"]');
      await seconds.fill('120');
      await seconds.press('Tab');
      await page.locator('.snt-crumb').getByText('edited, not written').waitFor();
      await page.locator('.snt-tools [data-act="echeck"]').click();
      // The real frame has the service check it and offers its own confirmation; the page writes nothing itself.
      const confirm = frame.getByRole('button', { name: 'Confirm writing the pipeline', exact: true });
      await confirm.waitFor({ timeout: 15000 });
      await page.locator('.snt-verdicts').getByText('checked · confirm in the owner panel').waitFor();
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), before, 'checking writes nothing');
      await page.screenshot({ path: join(evidence, 'checked-1440.png') });
      await confirm.click();
      await page
        .locator('.snt-verdicts')
        .getByText('written · adopt it from the command line')
        .waitFor({ timeout: 15000 });
      await page.locator('.snt-crumb').getByText('changed since adopted').waitFor();
      const edited = structuredClone(before);
      edited.stages[edited.stages.length - 1].budget = { seconds: 120 };
      assert.equal(readFileSync(path, 'utf8'), JSON.stringify(edited, null, 2) + '\n', 'exactly the edited bytes');
      const dir = join(f.ws.trustDir, 'receipts');
      const panel = readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')))
        .filter((r) => r.schema === 'sentinel-owneruireceipt/draft-1' && r.action === 'settings.adopt');
      assert.equal(panel.length, 1);
      assert.ok(existsSync(join(dir, `${panel[0].id}.spent`)));
      const after = loadPipeline({ workspace: f.ws.path, trustDir: f.ws.trustDir, readOnly: true });
      assert.equal(adopted.trust, 'adopted');
      assert.equal(after.trust, 'changed', 'written, not adopted');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: join(evidence, 'written-1280.png') });
      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(http, []);
    } finally {
      try {
        writeFileSync(join(evidence, 'diagnostic.json'), JSON.stringify({ errors, consoleErrors, http }, null, 2));
      } catch {}
      await browser?.close();
      await companion?.close();
      await service.stop();
      await socket.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([new Promise((r) => child!.once('exit', r)), wait(2000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      if (oldState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldState;
    }
  },
);
