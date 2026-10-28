// Actual browser → paired Farsight host → companion → production socket → genuine admitted work, read and driven
// from the Sentinel view (ADR 48, the owner-panel retirement): the view asks, the paired owner frame previews and the
// owner confirms there, and the view reads every scan, stage and report. One journey:
//
//   a spent pairing link explains recovery in a second tab; a scan the policy refuses is refused in the frame and does
//   not poison the owner CLI; a scan from the view prepares, and its start is confirmed in the frame with the source
//   removed; a lost connection disables the frame's confirmation until it recovers; the view reads the completed scan,
//   its stages and its report after the source is gone; the CLI's prepared run starts from the view's Start; the
//   pipeline is edited in the view, refused, withdrawn by a later edit and then written through the frame (never
//   adopted); a restarted read-only host refuses the frame's pending confirmation. Zero page errors, console errors
//   and unexpected HTTP errors.
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { adoptWorkspaceSettings } from '../dist/service/local.js';
import { loadPipeline } from '../dist/app/pipeline-adoption.js';
import { OwnerService } from '../dist/service/owner-service.js';
import { listenOwnerSocket, runtimeAddress, newOwnerNonce } from '../dist/transport/ipc.js';
import { writePrivateFileAtomic } from '../dist/policy/user-state.js';
import { startOwnerUi } from '../dist/owner-ui/server.js';
import { PreparationJournal } from '../dist/service/preparation-journal.js';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';
const cli = fileURLToPath(new URL('../../cli/dist/cli.js', import.meta.url)),
  port = Number(process.env.SENTINEL_OWNER_UI_PORT ?? 4583),
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  'the Sentinel view scans, starts, reads and edits through the paired owner frame, which alone confirms',
  {
    ...needsStore,
    skip:
      process.env.SENTINEL_OWNER_UI_BROWSER !== '1'
        ? 'explicit SENTINEL_OWNER_UI_BROWSER=1 browser gate'
        : needsStore.skip,
    timeout: 150000,
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
      process.env.SENTINEL_OWNER_UI_EVIDENCE ?? join(tmpdir(), 'owner-ui-surface-' + process.pid + '-' + Date.now());
    const errors: string[] = [],
      consoleErrors: string[] = [],
      http: any[] = [];
    let logs = '';
    const pipelinePath = join(f.ws.path, '.farsight', 'sentinel', 'pipeline.json');
    try {
      mkdirSync(evidence, { recursive: true });
      const graph = join(f.dir, 'graph.json');
      execFileSync(process.execPath, [cli, 'ingest', f.ws.path, '--repo', 'original-owner-fixture', '--out', graph], {
        cwd: f.dir,
        env: process.env,
        timeout: 30000,
      });
      const serve = (readOnly: boolean) => {
        const c = spawn(
          process.execPath,
          [cli, 'serve', graph, '--port', String(port), ...(readOnly ? ['--read-only'] : [])],
          { cwd: f.ws.path, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        c.stderr?.on('data', (b) => (logs += b));
        c.stdout?.on('data', (b) => (logs += b));
        return c;
      };
      child = serve(false);
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
      const frame = page.frameLocator('iframe[title="Sentinel"]'),
        scanButton = page.locator('.snt-tools .snt-scan'),
        ownerTab = page.locator('.snt-tabs [data-tab="owner"]'),
        confirmPrepare = frame.getByRole('button', { name: 'Confirm preparation', exact: true }),
        confirmControl = frame.getByRole('button', { name: 'Confirm this run action', exact: true }),
        accepted = frame.getByText('Action accepted. Retained status is shown below.', { exact: true });
      const scanAllowed = async () => {
        for (let i = 0; i < 100 && (await scanButton.getAttribute('aria-disabled')) === 'true'; i++) await wait(100);
        assert.equal(await scanButton.getAttribute('aria-disabled'), null, 'the view may start a scan');
      };
      await page.goto(`http://127.0.0.1:${port}/#/sentinel`);
      // The frame is the owner panel and nothing else: it pairs, hands the view its read pass, and waits to be asked.
      await ownerTab.click();
      await frame.getByText('Confirm here what you start from Sentinel.', { exact: true }).waitFor({ timeout: 15000 });
      for (const gone of [
        'Preview fresh capture',
        'Refresh retained state',
        'Read shareable report',
        'Stages and work',
      ])
        assert.equal(await frame.getByRole('button', { name: gone, exact: true }).count(), 0, gone);
      await scanAllowed();
      // A second browser context has no owner-origin reload token: its spent pairing link is a friendly refusal,
      // while the original paired tab stays usable and the duplicate authorizes nothing.
      const beforeDuplicate = f.store.ledger.currentSequence(),
        duplicateContext = await browser.newContext(),
        duplicate = await duplicateContext.newPage();
      await duplicate.goto(`http://127.0.0.1:${port}/#/sentinel`);
      await duplicate.locator('.snt-tabs [data-tab="owner"]').click();
      await duplicate
        .frameLocator('iframe[title="Sentinel"]')
        .getByRole('heading', {
          name: 'This pairing link has already been used or is no longer available.',
          exact: true,
        })
        .waitFor();
      await duplicateContext.close();
      assert.equal(f.store.ledger.currentSequence(), beforeDuplicate);

      // A scan the policy refuses: refused in the frame, and the owner CLI is not pinned by it.
      const settingsPath = join(f.ws.path, '.farsight/sentinel/settings.json'),
        settingsBytes = readFileSync(settingsPath),
        settings = JSON.parse(settingsBytes.toString());
      const policy = (deny: boolean) => {
        writeFileSync(settingsPath, deny ? JSON.stringify({ ...settings, grants: [] }) : settingsBytes);
        assert.equal(adoptWorkspaceSettings(f.ws, { confirm: true, now: new Date() }).outcome, 'prepared');
      };
      async function refuseScan() {
        policy(true);
        await scanButton.click();
        const [answer] = await Promise.all([
          page.waitForResponse((r) => r.url().endsWith('/confirm')),
          confirmPrepare.click(),
        ]);
        assert.equal((await answer.json()).outcome, 'configuration-failure');
        policy(false);
      }
      await refuseScan();
      const cliResult = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
          'prepare',
          '--confirm',
          '--workspace',
          f.ws.path,
          '--json',
        ],
        { env: process.env, timeout: 30000 },
      );
      const cliAnswer = JSON.parse(cliResult.stdout);
      assert.equal(cliAnswer.outcome, 'submitted', 'a refused UI request does not poison the CLI');
      for (let i = 0; i < 600 && service.busy; i++) await wait(10);
      const preparedRuns = () =>
        new PreparationJournal(f.store)
          .list()
          .filter((r: any) => r.phase === 'prepared' && r.runId)
          .map((r: any) => r.runId as string);
      await refuseScan();

      // The view's Scan: the frame confirms the preparation, waits for it, and previews the start.
      await scanButton.click();
      await confirmPrepare.click();
      await confirmControl.waitFor({ timeout: 30000 });
      await page.screenshot({ path: join(evidence, 'start-preview-1440.png') });
      // A lost connection disables the frame's confirmation; it recovers by itself, and nothing is written meanwhile.
      const beforeLoss = f.store.ledger.currentSequence();
      await page.route('**/events', (r) => r.abort());
      await frame
        .getByText(
          'The owner connection could not be verified. Actions are disabled; refresh retained state to reconnect.',
          { exact: true },
        )
        .waitFor({ timeout: 10000 });
      assert.equal(await confirmControl.isDisabled(), true);
      assert.equal(f.store.ledger.currentSequence(), beforeLoss);
      const expectedLossConsole = consoleErrors.splice(0);
      await page.unroute('**/events');
      for (let i = 0; i < 100 && (await confirmControl.isDisabled()); i++) await wait(50);
      assert.equal(await confirmControl.isEnabled(), true, 'the confirmation comes back with the connection');
      // The source goes before the start: the run reads what the preparation captured.
      rmSync(join(f.ws.path, 'src'), { recursive: true });
      await confirmControl.click();
      await accepted.waitFor();
      // the same captured bytes prepare the same run: the view's scan and the CLI's preparation name one run
      const runId = preparedRuns().at(-1)!;
      assert.ok(runId, 'the scan prepared a run');
      for (let i = 0; i < 300 && f.store.ledger.getRun(runId)?.state !== 'completed'; i++) await wait(100);
      assert.equal(f.store.ledger.getRun(runId)?.state, 'completed');
      // The view reads it: the list, the ladder, a stage and the report, with the source gone.
      await page.goto(`http://127.0.0.1:${port}/#/sentinel`);
      await page.locator(`.snt-scan-row[href="#/sentinel/${encodeURIComponent(runId)}"]`).click();
      await page.locator('.snt-card').first().waitFor({ timeout: 15000 });
      assert.ok((await page.locator('.snt-card').count()) >= 4);
      await page.locator('.snt-tabs [data-tab="stage"]').click();
      await page.screenshot({ path: join(evidence, 'pipeline-1440.png') });
      await page.locator('.snt-dock').getByRole('link', { name: 'Open the stage' }).click();
      await page.locator('.snt[data-stop="stage"] .snt-turn, .snt[data-stop="stage"] .snt-list').first().waitFor();
      assert.equal(await page.locator('.snt-stage .snt-empty.err').count(), 0);
      await page.locator('.snt-dock').getByRole('link', { name: 'Back to the pipeline' }).click();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('.snt-tools').getByRole('button', { name: 'Report · HTML' }).click(),
      ]);
      assert.match(download.suggestedFilename(), /^sentinel-scan-\d+\.html$/);
      assert.ok(readFileSync((await download.path())!, 'utf8').length > 100);

      // A run the CLI prepares over a changed source starts from the view: Start, previewed and confirmed in the frame.
      writeFileSync(join(f.ws.path, 'src.ts'), 'export const two = 2;\n');
      const cliPrepared = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
          'prepare',
          '--confirm',
          '--workspace',
          f.ws.path,
          '--json',
        ],
        { env: process.env, timeout: 30000 },
      );
      assert.equal(JSON.parse(cliPrepared.stdout).outcome, 'submitted');
      for (let i = 0; i < 300 && !preparedRuns().some((id) => id !== runId); i++) await wait(50);
      const cliRun = preparedRuns().find((id) => id !== runId)!;
      assert.ok(cliRun, 'the CLI prepared a second run');
      {
        await page.goto(`http://127.0.0.1:${port}/#/sentinel/${encodeURIComponent(cliRun)}`);
        const start = page.locator('.snt-tools [data-act="control"][data-action="start"]');
        await start.waitFor({ timeout: 15000 });
        await start.click();
        await confirmControl.click();
        await accepted.waitFor();
        for (let i = 0; i < 300 && f.store.ledger.getRun(cliRun)?.state !== 'completed'; i++) await wait(100);
        assert.equal(f.store.ledger.getRun(cliRun)?.state, 'completed');
      }

      // The pipeline, edited in the view and written by the frame on its own confirmation, never adopted.
      const before = JSON.parse(readFileSync(pipelinePath, 'utf8')),
        adopted = loadPipeline({ workspace: f.ws.path, trustDir: f.ws.trustDir, readOnly: true });
      await page.goto(`http://127.0.0.1:${port}/#/sentinel?edit=1&pick=report`);
      await page
        .locator('.snt-erow:not(.gone)')
        .nth(before.stages.length - 1)
        .waitFor({ timeout: 15000 });
      await page.locator('.snt-eadd [data-enew="agent"]').click();
      await page.locator('.snt-tools [data-act="echeck"]').click();
      await page
        .locator('.snt-verdicts')
        .getByText(/the pipeline file is not a valid pipeline \(\/stages\/\d+: required: must have required property/)
        .waitFor({ timeout: 15000 });
      const confirmWrite = frame.getByRole('button', { name: 'Confirm writing the pipeline', exact: true });
      assert.equal(await confirmWrite.count(), 0);
      await page.locator('.snt-tools [data-act="ediscard"]').click();
      await page.locator('.snt-erow[data-estage="report"]').click();
      const seconds = page.locator('.snt-dock [data-ebudget="seconds"]');
      await seconds.fill('120');
      await seconds.press('Tab');
      await page.locator('.snt-tools [data-act="echeck"]').click();
      await confirmWrite.waitFor({ timeout: 15000 });
      // An edit after Check withdraws the frame's confirmation for the earlier bytes; checking again offers a new one.
      await page.locator('.snt-tabs [data-tab="stage"]').click();
      await seconds.fill('121');
      await seconds.press('Tab');
      await ownerTab.click();
      await frame
        .getByText('The page changed the pipeline after it was checked: nothing was written. Check it again.', {
          exact: true,
        })
        .waitFor({ timeout: 15000 });
      assert.equal(await confirmWrite.count(), 0);
      // A check still out with the service when the page edits: its answer is dropped, no confirmation appears.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      await page.route('**/pipeline-preview', async (route) => {
        await held;
        await route.continue();
      });
      await page.locator('.snt-tabs [data-tab="stage"]').click();
      await seconds.fill('120');
      await seconds.press('Tab');
      const answered = page.waitForResponse((r) => r.url().endsWith('/pipeline-preview'));
      await page.locator('.snt-tools [data-act="echeck"]').click();
      await page.locator('.snt-tabs [data-tab="stage"]').click();
      await seconds.fill('122');
      await seconds.press('Tab');
      release();
      await answered;
      await page.unroute('**/pipeline-preview');
      await page.locator('.snt-tabs [data-tab="owner"]').click();
      await frame
        .getByText('The page changed the pipeline after it was checked: nothing was written. Check it again.', {
          exact: true,
        })
        .waitFor({ timeout: 15000 });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await confirmWrite.count(), 0, 'a withdrawn check offers no confirmation');
      assert.equal(await page.locator('.snt-verdicts').getByText('checked · confirm in the owner panel').count(), 0);
      // Discard after a check withdraws it as well.
      await page.locator('.snt-tools [data-act="echeck"]').click();
      await confirmWrite.waitFor({ timeout: 15000 });
      await page.locator('.snt-tools [data-act="ediscard"]').click();
      for (let i = 0; i < 100 && (await confirmWrite.count()); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(await confirmWrite.count(), 0, 'a discarded draft offers no confirmation');
      assert.deepEqual(JSON.parse(readFileSync(pipelinePath, 'utf8')), before);
      await page.locator('.snt-erow[data-estage="report"]').click();
      // The same bytes checked twice, the first answer late: each check has its own token, so only the second check's
      // answer offers a confirmation.
      const holds: Array<() => void> = [];
      await page.route('**/pipeline-preview', async (route) => {
        await new Promise<void>((r) => holds.push(r));
        await route.continue();
      });
      await page.locator('.snt-tabs [data-tab="stage"]').click();
      await seconds.fill('120');
      await seconds.press('Tab');
      await page.locator('.snt-tools [data-act="echeck"]').click();
      for (let i = 0; i < 200 && holds.length < 1; i++) await new Promise((r) => setTimeout(r, 25));
      await page.locator('.snt-tabs [data-tab="stage"]').click();
      await seconds.fill('125');
      await seconds.press('Tab');
      await seconds.fill('120');
      await seconds.press('Tab');
      await page.locator('.snt-tools [data-act="echeck"]').click();
      for (let i = 0; i < 200 && holds.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(holds.length, 2, 'two checks of the same bytes are out');
      const firstAnswer = page.waitForResponse((r) => r.url().endsWith('/pipeline-preview'));
      holds[0]!();
      await firstAnswer;
      await new Promise((r) => setTimeout(r, 300));
      await page.locator('.snt-tabs [data-tab="owner"]').click();
      assert.equal(await confirmWrite.count(), 0, 'the earlier check of the same bytes offers nothing');
      holds[1]!();
      await confirmWrite.waitFor({ timeout: 15000 });
      await page.unroute('**/pipeline-preview');
      assert.deepEqual(JSON.parse(readFileSync(pipelinePath, 'utf8')), before, 'checking writes nothing');
      await confirmWrite.click();
      await page
        .locator('.snt-verdicts')
        .getByText('written · adopt it from the command line')
        .waitFor({ timeout: 15000 });
      const edited = structuredClone(before);
      edited.stages[edited.stages.length - 1].budget = { seconds: 120 };
      assert.equal(readFileSync(pipelinePath, 'utf8'), JSON.stringify(edited, null, 2) + '\n');
      const receipts = join(f.ws.trustDir, 'receipts'),
        writes = readdirSync(receipts)
          .filter((n) => n.endsWith('.json'))
          .map((n) => JSON.parse(readFileSync(join(receipts, n), 'utf8')))
          .filter((r) => r.schema === 'sentinel-owneruireceipt/draft-1' && r.action === 'settings.adopt');
      assert.equal(writes.length, 1);
      assert.ok(existsSync(join(receipts, `${writes[0].id}.spent`)));
      assert.equal(adopted.trust, 'adopted');
      assert.equal(loadPipeline({ workspace: f.ws.path, trustDir: f.ws.trustDir, readOnly: true }).trust, 'changed');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: join(evidence, 'pipeline-written-1280.png') });
      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors, [], JSON.stringify({ http, consoleErrors }));
      assert.deepEqual(http, []);

      // Our own host restarted read-only at the same origin: the frame's pending confirmation is refused at the
      // immediate host fence before any receipt is issued or spent.
      await page.goto(`http://127.0.0.1:${port}/#/sentinel`);
      await scanAllowed();
      await scanButton.click();
      await confirmPrepare.waitFor({ timeout: 15000 });
      const beforeRestart = f.store.ledger.currentSequence(),
        receiptNames = readdirSync(receipts).sort();
      child.kill('SIGTERM');
      await new Promise((r) => child!.once('exit', r));
      child = serve(true);
      for (let i = 0; i < 200; i++) {
        try {
          const v: any = await (await fetch(`http://127.0.0.1:${port}/api/version`)).json();
          if (v.session?.readOnly) break;
        } catch {}
        await wait(20);
      }
      await confirmPrepare.click();
      await frame
        .locator('#message')
        .getByText('The paired application is unavailable or changed.', { exact: true })
        .waitFor();
      assert.equal(f.store.ledger.currentSequence(), beforeRestart);
      assert.deepEqual(readdirSync(receipts).sort(), receiptNames);
      assert.deepEqual(errors, []);
      assert.equal(http.length, 1);
      assert.equal(http[0].status, 400);
      assert.ok(http[0].url.endsWith('/confirm'));
      const expectedGuardHttp = http.splice(0),
        expectedGuardConsole = consoleErrors.splice(0);
      writeFileSync(
        join(evidence, 'result.json'),
        JSON.stringify(
          {
            genuineOwner: true,
            browser: 'chromium',
            frameIsConfirmationOnly: true,
            usedPairingLinkRecovery: true,
            policyRefusalThenUiAndCliRecovery: true,
            scanFromTheView: true,
            connectionLossDisablesConfirmation: true,
            expectedLossConsole,
            sourceRemovedBeforeStart: true,
            viewReadsScanStageAndReport: true,
            viewStartsThePreparedCliRun: true,
            pipelineRefusedWithdrawnThenWrittenNotAdopted: true,
            hostRestartRefused: true,
            expectedGuardHttp,
            expectedGuardConsole,
            errors,
            consoleErrors,
            http,
            hostLog: logs,
          },
          null,
          2,
        ),
      );
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
