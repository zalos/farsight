// The PIPELINE stop's edit mode (Sentinel v2 lane L-UX U-3): the workspace's pipeline file drawn as its ladder, a
// stage edited in the drawer with its JSON beneath, `+ add a stage here`, and the edited copy handed to the paired
// owner frame, which has the service check it and writes it on the owner's confirmation. The page learns the service's
// answer and nothing that confirms; adoption stays the owner command line's.
//
// No Docker, model or owner service here: the answers below were recorded from the owner service's own operations over
// a genuine workspace (owner-ui.pipeline, owner-ui.pipeline-preview, owner-ui.pipeline-write — the same calls
// packages/sentinel/test/owner-ui-stage-config.test.ts makes). The companion is a stand-in at a loopback origin nothing
// listens on: page.route serves its frame, which pairs, hands the page a read pass, and answers a pipeline it is handed
// with the recorded check, then the recorded write when its confirm button is pressed (ADR 8: stand-ins through
// page.route, never MSW). packages/sentinel/test/owner-ui-stage-config-browser.test.ts runs the same flow through the
// real companion and service.
import type { Page, Route } from '@playwright/test';
import { test, expect, gotoReady } from './support';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const STUB = 'http://127.0.0.1:4579';
const PASS = 'b'.repeat(64);
const EDIT = '#/sentinel?edit=1';

/** Recorded genuine answers: the file read, an edit checked, two refusals, the write, and the file read after it. */
const RECORDED: Json = {
  'edited': {
    'schema': 'sentinel-pipeline/draft-1',
    'id': 'default',
    'revision': 1,
    'stages': [
      { 'id': 'capture', 'kind': 'builtin', 'operation': 'capture' },
      { 'id': 'parse', 'kind': 'builtin', 'operation': 'parse', 'needs': ['capture'], 'fanOut': 'per-source' },
      { 'id': 'inventory', 'kind': 'builtin', 'operation': 'inventory', 'needs': ['parse'] },
      {
        'id': 'preview',
        'kind': 'tool',
        'adapter': 'sentinel.preview.detector',
        'rules': ['sentinel.preview.sql-string-concat'],
        'needs': ['capture', 'inventory'],
      },
      { 'id': 'report', 'kind': 'builtin', 'operation': 'report', 'needs': ['preview'], 'budget': { 'seconds': 120 } },
    ],
  },
  'read': {
    'schema': 'sentinel-viewer-pipeline/draft-1',
    'trust': 'adopted',
    'reasonCode': null,
    'pipeline': {
      'schema': 'sentinel-pipeline/draft-1',
      'id': 'default',
      'revision': 1,
      'stages': [
        {
          'id': 'capture',
          'kind': 'builtin',
          'operation': 'capture',
        },
        {
          'id': 'parse',
          'kind': 'builtin',
          'operation': 'parse',
          'needs': ['capture'],
          'fanOut': 'per-source',
        },
        {
          'id': 'inventory',
          'kind': 'builtin',
          'operation': 'inventory',
          'needs': ['parse'],
        },
        {
          'id': 'preview',
          'kind': 'tool',
          'adapter': 'sentinel.preview.detector',
          'rules': ['sentinel.preview.sql-string-concat'],
          'needs': ['capture', 'inventory'],
        },
        {
          'id': 'report',
          'kind': 'builtin',
          'operation': 'report',
          'needs': ['preview'],
        },
      ],
    },
    'fileDigest': 'sha256:4553538a6ff9215b720ba1685426e0aebc2057fed264ae7575fc86ee9fe01cfd',
    'digest': 'sha256:57a1f61171d291424c74823b1e17fc386975bfec80f37f7d464610767f3545a3',
    'problems': [],
    'readOnly': true,
  },
  'checked': {
    'outcome': 'configuration-failure',
    'reasonCode': 'sentinel.admission.ownerOnly',
    'problems': [],
    'preview': {
      'stages': [
        {
          'id': 'capture',
          'kind': 'builtin',
          'order': 0,
          'where': 'in-process',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
        {
          'id': 'parse',
          'kind': 'builtin',
          'order': 1,
          'where': 'child',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
        {
          'id': 'inventory',
          'kind': 'builtin',
          'order': 2,
          'where': 'child',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
        {
          'id': 'preview',
          'kind': 'tool',
          'order': 3,
          'where': 'child',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
        {
          'id': 'report',
          'kind': 'builtin',
          'order': 4,
          'where': 'in-process',
          'effects': ['local-artifacts'],
          'change': 'changed',
        },
      ],
      'removed': [],
    },
  },
  'refused': {
    'outcome': 'configuration-failure',
    'reasonCode': 'sentinel.pipeline.duplicateStage',
    'problems': [
      {
        'class': 'refused',
        'code': 'sentinel.pipeline.duplicateStage',
        'stage': 'capture',
        'detail': 'stage capture is declared twice',
      },
    ],
    'preview': {
      'stages': [
        {
          'id': 'capture',
          'kind': 'builtin',
          'order': 0,
          'where': 'in-process',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
        {
          'id': 'capture',
          'kind': 'builtin',
          'order': 0,
          'where': 'in-process',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
        {
          'id': 'parse',
          'kind': 'builtin',
          'order': 1,
          'where': 'child',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
        {
          'id': 'inventory',
          'kind': 'builtin',
          'order': 2,
          'where': 'child',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
        {
          'id': 'preview',
          'kind': 'tool',
          'order': 3,
          'where': 'child',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
        {
          'id': 'report',
          'kind': 'builtin',
          'order': 4,
          'where': 'in-process',
          'effects': ['local-artifacts'],
          'change': 'unchanged',
        },
      ],
      'removed': [],
    },
    'unavailable': true,
  },
  'added': {
    'detail': "/stages/1: required: must have required property 'mode'",
    'outcome': 'configuration-failure',
    'reasonCode': 'sentinel.pipeline.invalid',
    'problems': [],
    'preview': null,
    'unavailable': true,
  },
  'written': {
    'written': true,
    'fileDigest': 'sha256:b53833fd44c5811431f7eb018ba45a352577aac09d4f0f2d2e24014f4d4a8563',
    'digest': 'sha256:4e4f8799e9e19bf8e99643873ef65b8e76d7d0ae41634b4ed5db927c01ec1daf',
    'trust': 'changed',
  },
  'after': {
    'schema': 'sentinel-viewer-pipeline/draft-1',
    'trust': 'changed',
    'reasonCode': null,
    'fileDigest': 'sha256:b53833fd44c5811431f7eb018ba45a352577aac09d4f0f2d2e24014f4d4a8563',
    'digest': 'sha256:4e4f8799e9e19bf8e99643873ef65b8e76d7d0ae41634b4ed5db927c01ec1daf',
    'problems': [],
    'readOnly': true,
  },
};

/** Identifier-shaped tokens (the ladder spec's list). */
const IDENTIFIER = new RegExp(
  [
    String.raw`\b[a-z]+[A-Z][A-Za-z0-9]*\b`,
    String.raw`\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b`,
    String.raw`\b[a-z0-9]+_[a-z0-9_]+\b`,
    String.raw`\b[A-Z0-9]+_[A-Z0-9_]+\b`,
    String.raw`(?:^|[\s(])\/[\w.:{}\-]+`,
    String.raw`\.(?:tsx?|jsx?|mjs|json)\b`,
    String.raw`sha256:`,
    String.raw`\b[0-9a-f]{8,}\b`,
    String.raw`\bsentinel\.[a-z]`,
  ].join('|'),
  'g',
);

async function standIn(page: Page, baseURL: string | undefined, opts: { readOnly?: boolean } = {}) {
  const origin = new URL(baseURL ?? 'http://localhost').origin;
  const version: Json = await (await page.request.get('/api/version')).json();
  const instance = version.session.instance;
  // what the frame was handed, and whether the owner confirmed its write
  const state: { got: Json; written: boolean; checks: Json[]; withdrawn: number } = {
    got: null,
    written: false,
    checks: [],
    withdrawn: 0,
  };
  await page.exposeFunction('__sentinelGot', (pipeline: Json, written: boolean, check: Json) => {
    state.got = pipeline;
    state.written = state.written || written;
    if (check) state.checks.push(check);
  });
  await page.exposeFunction('__sentinelWithdrawn', () => {
    state.withdrawn++;
  });
  await page.route(
    (url) => url.pathname === '/' || url.pathname === '/index.html',
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        'data-sentinel-owner-origin=""',
        `data-sentinel-owner-origin="${STUB}"`,
      );
      const csp = response.headers()['content-security-policy'] ?? '';
      await route.fulfill({
        response,
        body,
        headers: { ...response.headers(), 'content-security-policy': `${csp} ${STUB}` },
      });
    },
  );
  if (opts.readOnly)
    await page.route('**/api/version', async (route) => {
      const response = await route.fetch();
      const v = await response.json();
      await route.fulfill({ response, json: { ...v, session: { ...v.session, readOnly: true, why: 'flag' } } });
    });
  await page.route('**/api/sentinel/companion', (route) =>
    route.fulfill({ json: { available: true, ownerOrigin: STUB }, headers: { 'cache-control': 'no-store' } }),
  );
  // The paired owner frame: pairs, hands a read pass; a pipeline it is handed is answered with the recorded check (or
  // a recorded refusal), and its own confirm button answers with the recorded write.
  await page.route(`${STUB}/frame`, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><meta charset="utf-8"><body><p id="said">paired</p><div id="confirm"></div><script>
        const parentOrigin = ${JSON.stringify(origin)}, hostInstance = ${JSON.stringify(instance)};
        const R = ${JSON.stringify(RECORDED)};
        const frameNonce = 'frame-' + '1'.repeat(32), documentId = 'document-' + '2'.repeat(32), id = '3'.repeat(64);
        let draft = null,
          got = null;
        const tell = (v, digest = draft) => parent.postMessage({ type: 'sentinel-owner-pipeline-result', frameNonce, documentId, hostInstance,
          state: v.state, draftDigest: digest, reasonCode: v.reasonCode ?? null, detail: v.detail ?? null, problems: v.problems ?? [], preview: v.preview ?? null,
          written: v.written ?? null }, parentOrigin);
        addEventListener('message', (e) => {
          if (e.origin !== parentOrigin || !e.data) return;
          if (e.data.type === 'sentinel-owner-context' && e.data.id === id)
            parent.postMessage({ type: 'sentinel-owner-read', frameNonce, documentId, hostInstance,
              pass: ${JSON.stringify(PASS)}, expiresAt: new Date(Date.now() + 3600000).toISOString() }, parentOrigin);
          if (e.data.type === 'sentinel-owner-pipeline-withdraw' && e.data.frameNonce === frameNonce) {
            // the page edited after its check: the confirmation goes; a race button keeps the earlier one, as an owner
            // who pressed confirm before the withdraw arrived would
            window.__sentinelWithdrawn();
            const kept = draft,
              keptPipeline = got;
            document.getElementById('said').textContent = 'withdrawn';
            const late = document.createElement('button');
            late.textContent = 'Write the earlier check';
            late.onclick = () => {
              late.remove();
              window.__sentinelGot(keptPipeline, true);
              tell({ state: 'written', problems: R.checked.problems, preview: R.checked.preview, written: R.written }, kept);
            };
            document.getElementById('confirm').replaceChildren(late);
            return;
          }
          if (e.data.type !== 'sentinel-owner-pipeline' || e.data.frameNonce !== frameNonce) return;
          const p = e.data.pipeline;
          draft = e.data.draftDigest;
          got = p;
          window.__sentinelGot(p, false, { draftDigest: e.data.draftDigest, expectDigest: e.data.expectDigest });
          document.getElementById('said').textContent = 'checking';
          // the recorded refusals: an empty agent stage, and (a stand-in rule) a capture stage made one per source
          if (p.stages.some((s) => s.kind === 'agent' && !s.model))
            return tell({ state: 'refused', reasonCode: R.added.reasonCode, detail: R.added.detail, problems: R.added.problems });
          if (p.stages.some((s) => s.id === 'capture' && s.fanOut === 'per-source'))
            return tell({ state: 'refused', reasonCode: R.refused.reasonCode, problems: R.refused.problems });
          tell({ state: 'checked', problems: R.checked.problems, preview: R.checked.preview });
          const b = document.createElement('button');
          b.textContent = 'Confirm writing the pipeline';
          b.onclick = () => {
            b.remove();
            window.__sentinelGot(p, true);
            tell({ state: 'written', problems: R.checked.problems, preview: R.checked.preview, written: R.written });
          };
          document.getElementById('confirm').replaceChildren(b);
        });
        parent.postMessage({ type: 'sentinel-owner-context-request', id, frameNonce, documentId, hostInstance }, parentOrigin);
      </script></body>`,
    }),
  );
  await page.route(`${STUB}/api/sentinel/**`, async (route: Route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': origin, vary: 'Origin' };
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'authorization' },
      });
    if (req.headers()['authorization'] !== `Bearer ${PASS}`)
      return route.fulfill({ status: 401, headers: cors, json: { error: 'sentinel.viewer.notPaired' } });
    const path = new URL(req.url()).pathname.replace('/api/sentinel/', '');
    if (path === 'pipeline')
      return route.fulfill({
        headers: cors,
        json: state.written ? { ...RECORDED.after, pipeline: state.got } : RECORDED.read,
      });
    if (path === 'scans')
      return route.fulfill({
        headers: cors,
        json: {
          schema: 'sentinel-viewer-scans/draft-1',
          workspace: 'workspace',
          scans: [],
          counts: {},
          page: { before: null, older: null },
        },
      });
    return route.fulfill({ status: 404, headers: cors, json: { error: 'sentinel.viewer.scanUnknown' } });
  });
  return state;
}

async function visibleWords(page: Page, root: string): Promise<string> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const r of Array.from(document.querySelectorAll(sel))) {
      const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = w.nextNode())) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim()) continue;
        if (el.closest('[hidden],iframe')) continue;
        const box = el.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        out.push(n.textContent.trim());
      }
    }
    return out.join('\n');
  }, root);
}

const rows = (page: Page) => page.locator('.snt-erow:not(.gone)');
const row = (page: Page, id: string) => page.locator(`.snt-erow[data-estage="${id}"]`);
const frame = (page: Page) => page.frameLocator('.snt-owner iframe');

test.describe('the PIPELINE edit mode', () => {
  test('draws the pipeline file as its ladder; a stage opens in the drawer with its JSON beneath', async ({
    page,
    baseURL,
  }) => {
    await standIn(page, baseURL);
    await gotoReady(page, EDIT);
    await expect(rows(page)).toHaveCount(RECORDED.read.pipeline.stages.length);
    await expect(page.locator('.snt-stops [data-stop="pipeline"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.snt-crumb')).toContainText(/the pipeline/i);
    await expect(page.locator('.snt-crumb')).toContainText(/adopted/i);
    await expect(page.locator('.snt-layouts [data-layout="table"]')).toHaveAttribute('aria-disabled', 'true');
    await row(page, 'report').click();
    await expect(page).toHaveURL(/edit=1&pick=report/);
    const drawer = page.locator('.snt-dock [data-pane="stage"]');
    await expect(drawer.locator('h2')).toHaveText('Stage 5 · Write the report · report'); // hybrid: both names
    await expect(drawer.locator('[data-ekind="builtin"]')).toHaveClass(/\bon\b/);
    await expect(drawer.locator('[data-efield="operation"][data-evalue="report"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('.snt-json')).toContainText('"operation": "report"');
    // nothing to check before an edit
    await expect(page.locator('.snt-tools [data-act="echeck"]')).toHaveAttribute('aria-disabled', 'true');
  });

  test("an edit, checked and confirmed in the owner panel, writes exactly the edited bytes; adopting stays the CLI owner's", async ({
    page,
    baseURL,
  }) => {
    const state = await standIn(page, baseURL);
    await gotoReady(page, EDIT + '&pick=report');
    const drawer = page.locator('.snt-dock [data-pane="stage"]');
    await drawer.locator('[data-ebudget="seconds"]').fill('120');
    await drawer.locator('[data-ebudget="seconds"]').press('Tab');
    await expect(page.locator('.snt-crumb')).toContainText(/edited, not written/i);
    await expect(row(page, 'report')).toContainText(/edited/i);
    await expect(page.locator('.snt-json')).toContainText('"seconds": 120');
    await page.locator('.snt-tools [data-act="echeck"]').click();
    // the frame was handed exactly the edited pipeline, and the page shows the owner panel to confirm in
    await expect.poll(() => state.got).toEqual(RECORDED.edited);
    await expect(page.locator('.snt-tabs [data-tab="owner"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('.snt-verdicts')).toContainText(/checked · confirm in the owner panel/i);
    await expect(row(page, 'report')).toContainText(/changed/i);
    await expect(row(page, 'capture')).toContainText(/reuses/i);
    await frame(page).getByRole('button', { name: 'Confirm writing the pipeline' }).click();
    await expect(page.locator('.snt-verdicts')).toContainText(/written · adopt it from the command line/i);
    await expect(page.locator('.snt-crumb')).toContainText(/changed since adopted/i);
    await expect(page.locator('.snt-crumb')).not.toContainText(/edited, not written/i);
    await expect(page.locator('.snt-stage')).toContainText('farsight-sentinel pipeline adopt --confirm');
    expect(state.written).toBe(true);
    // the bytes written are the bytes the CLI writes for that object: two-space JSON and a final newline
    expect(JSON.stringify(state.got, null, 2) + '\n').toBe(JSON.stringify(RECORDED.edited, null, 2) + '\n');
  });

  test('+ add a stage here adds one after the picked stage; refusals come back as the service said them', async ({
    page,
    baseURL,
  }) => {
    const state = await standIn(page, baseURL);
    await gotoReady(page, EDIT + '&pick=capture');
    await page.locator('.snt-eadd [data-enew="agent"]').click();
    await expect(page).toHaveURL(/pick=review/);
    await expect(rows(page).nth(1)).toContainText('review');
    const drawer = page.locator('.snt-dock [data-pane="stage"]');
    await expect(drawer.locator('[data-ekind="agent"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('.snt-json')).toContainText('"needs": [');
    await page.locator('.snt-tools [data-act="echeck"]').click();
    await expect.poll(() => state.got?.stages?.[1]).toEqual({ id: 'review', kind: 'agent', needs: ['capture'] });
    await expect(page.locator('.snt-verdicts')).toContainText(
      "the pipeline file is not a valid pipeline (/stages/1: required: must have required property 'mode')",
    );
    await expect(page.locator('.snt-tabs [data-tab="stage"]')).toHaveClass(/\bon\b/);
    // removing it, then a stage problem the service names lands on that stage
    await page.locator('.snt-dock [data-act="eremove"]').click();
    await expect(rows(page)).toHaveCount(RECORDED.read.pipeline.stages.length);
    await row(page, 'capture').click();
    await drawer.locator('[data-efield="fanOut"][data-evalue="per-source"]').click();
    await page.locator('.snt-tools [data-act="echeck"]').click();
    await expect(row(page, 'capture')).toContainText(/problem/i);
    await expect(drawer.locator('.snt-eprob')).toBeVisible();
    // Discard: the file as it is
    await page.locator('.snt-tools [data-act="ediscard"]').click();
    await expect(page.locator('.snt-crumb')).not.toContainText(/edited, not written/i);
  });

  test('a read-only server greys Check with its reason', async ({ page, baseURL }) => {
    await standIn(page, baseURL, { readOnly: true });
    await gotoReady(page, EDIT + '&pick=report');
    await page.locator('.snt-dock [data-ebudget="seconds"]').fill('60');
    await page.locator('.snt-dock [data-ebudget="seconds"]').press('Tab');
    await expect(page.locator('.snt-tools [data-act="echeck"]')).toHaveAttribute('aria-disabled', 'true');
  });

  test('the business register names each stage in words and prints no identifier, in text or in a field', async ({
    page,
    baseURL,
  }) => {
    await standIn(page, baseURL);
    const stages = RECORDED.read.pipeline.stages;
    // every id the file holds, and every raw value a choice could print
    const ids = new Set<string>(
      [
        ...stages.flatMap((st: Json) => [
          st.id,
          st.adapter,
          st.operation,
          ...(Array.isArray(st.rules) ? st.rules : []),
        ]),
        // a kind's catalog words (tool · script · agent) and a declared name such as review are words, not ids
        ...['builtin', 'framework-controls', 'walkthrough', 'container', 'host', 'node', 'sh'],
        ...['brokered', 'native', 'copilot-cli', 'claude-cli', 'hosted-api', 'ollama'],
        ...['per-run', 'per-source', 'per-entry', 'per-check'],
      ].filter((x): x is string => typeof x === 'string'),
    );
    const look = async (where: string) => {
      const texts = (await visibleWords(page, '.snt-chrome, .snt-stage, .snt-dock')).split('\n');
      const values = await page
        .locator('.snt-dock input')
        .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
      for (const text of texts) {
        expect(ids.has(text), `${where}: "${text}" is an id`).toBe(false);
        for (const id of ids)
          if (/[-.:/]/.test(id)) expect(text.includes(id), `${where}: "${text}" holds ${id}`).toBe(false);
        expect(text.match(IDENTIFIER) ?? [], `${where}: ${text}`).toEqual([]);
      }
      for (const value of values) expect(value, `${where}: a field shows "${value}"`).toMatch(/^[0-9.]*$/);
    };
    for (const pick of stages.map((st: Json) => st.id)) {
      await gotoReady(page, EDIT + '&pick=' + pick + '&lens=business');
      await expect(page.locator('.snt-dock h2')).toContainText('Stage');
      await look(pick);
    }
    // the stages read in words: a builtin by its operation, a scanner by what it checks
    await expect(page.locator('.snt-erow').nth(0)).toContainText('Capture the source');
    await expect(page.locator('.snt-erow').filter({ hasText: 'Preview pattern check' })).toHaveCount(1);
    // after an added model stage and a check answered
    await page.locator('.snt-eadd [data-enew="agent"]').click();
    await expect(page.locator('.snt-dock [data-ekind="agent"]')).toHaveClass(/\bon\b/);
    await look('the added stage');
    await page.locator('.snt-dock [data-act="eremove"]').click();
    await gotoReady(page, EDIT + '&pick=report&lens=business');
    await page.locator('.snt-dock [data-ebudget="seconds"]').fill('90');
    await page.locator('.snt-dock [data-ebudget="seconds"]').press('Tab');
    await page.locator('.snt-tools [data-act="echeck"]').click();
    await expect(page.locator('.snt-verdicts')).toContainText(/checked/i);
    await page.locator('.snt-tabs [data-tab="stage"]').click();
    await look('after a check');
  });

  test('an edit after Check withdraws the confirmation; a write of the earlier check keeps the newer draft', async ({
    page,
    baseURL,
  }) => {
    const state = await standIn(page, baseURL);
    await gotoReady(page, EDIT + '&pick=report');
    const seconds = page.locator('.snt-dock [data-ebudget="seconds"]');
    await seconds.fill('120');
    await seconds.press('Tab');
    await page.locator('.snt-tools [data-act="echeck"]').click();
    await expect(frame(page).getByRole('button', { name: 'Confirm writing the pipeline' })).toBeVisible();
    // the check named the draft by the digest of the bytes it would write
    await expect.poll(() => state.checks.length).toBe(1);
    expect(state.checks[0].draftDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // a later edit in the page: the frame's confirmation for the earlier bytes is withdrawn
    await page.locator('.snt-tabs [data-tab="stage"]').click();
    await seconds.fill('180');
    await seconds.press('Tab');
    await expect.poll(() => state.withdrawn).toBe(1);
    await expect(frame(page).getByRole('button', { name: 'Confirm writing the pipeline' })).toHaveCount(0);
    // an owner who confirmed the earlier check before the withdraw arrived: the file holds that version, and the
    // newer draft stays here, unwritten, on top of it
    await page.locator('.snt-tabs [data-tab="owner"]').click();
    await frame(page).getByRole('button', { name: 'Write the earlier check' }).click();
    await expect(page.locator('.snt-verdicts')).toContainText(/written · an earlier version/i);
    await expect(page.locator('.snt-crumb')).toContainText(/edited, not written/i);
    await expect(page.locator('.snt-stage')).toContainText(/later changes are still here/i);
    await page.locator('.snt-tabs [data-tab="stage"]').click();
    await expect(seconds).toHaveValue('180');
    await expect(page.locator('.snt-json')).toContainText('"seconds": 180');
    // Discard after a check withdraws it too: nothing the frame offers can write a draft the page dropped
    await page.locator('.snt-tools [data-act="echeck"]').click();
    await expect.poll(() => state.checks.length).toBe(2);
    await page.locator('.snt-tools [data-act="ediscard"]').click();
    await expect.poll(() => state.withdrawn).toBe(2);
    await expect(page.locator('.snt-crumb')).not.toContainText(/edited, not written/i);
    await page.locator('.snt-tabs [data-tab="stage"]').click();
    await seconds.fill('180');
    await seconds.press('Tab');
    // checking the newer draft again replaces the file the earlier write left, not the one first read
    await page.locator('.snt-tools [data-act="echeck"]').click();
    await expect.poll(() => state.checks.length).toBe(3);
    expect(state.checks[2].expectDigest).toBe(RECORDED.written.fileDigest);
    expect(state.checks[2].draftDigest).not.toBe(state.checks[0].draftDigest);
  });

  test('a write answered while the page is still hashing its draft never clears an edit made meanwhile', async ({
    page,
    baseURL,
  }) => {
    // the page hashes its draft before it compares an answer; slowed here, so an edit lands inside that await
    await page.addInitScript(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        if ((globalThis as any).__slowDigest) await new Promise((r) => setTimeout(r, 700));
        return digest(algorithm, data);
      };
    });
    await standIn(page, baseURL);
    await gotoReady(page, EDIT + '&pick=report');
    const seconds = page.locator('.snt-dock [data-ebudget="seconds"]');
    await seconds.fill('120');
    await seconds.press('Tab');
    await page.locator('.snt-tools [data-act="echeck"]').click();
    const confirm = frame(page).getByRole('button', { name: 'Confirm writing the pipeline' });
    await expect(confirm).toBeVisible();
    await page.evaluate(() => ((globalThis as any).__slowDigest = true));
    await confirm.click(); // the frame answers written for the 120 bytes; the page starts hashing its draft
    await page.locator('.snt-tabs [data-tab="stage"]').click();
    await seconds.fill('150');
    await seconds.press('Tab');
    await expect(page.locator('.snt-verdicts')).toContainText(/written · an earlier version/i);
    await expect(page.locator('.snt-crumb')).toContainText(/edited, not written/i);
    await expect(seconds).toHaveValue('150');
  });

  for (const width of [1440, 1280])
    test(`nothing scrolls sideways at ${width}, with the drawer open and a check answered`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await standIn(page, baseURL);
      await gotoReady(page, EDIT + '&pick=preview');
      await page.locator('.snt-dock [data-ebudget="seconds"]').fill('90');
      await page.locator('.snt-dock [data-ebudget="seconds"]').press('Tab');
      await page.locator('.snt-tools [data-act="echeck"]').click();
      await expect(page.locator('.snt-verdicts')).toContainText(/checked/i);
      await page.locator('.snt-tabs [data-tab="stage"]').click();
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(over).toBeLessThanOrEqual(0);
      // the drawer's fields stay inside the dock
      const dock = await page.locator('.snt-dock').boundingBox();
      for (const box of await page
        .locator('.snt-dock input')
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right)))
        expect(box).toBeLessThanOrEqual(dock!.x + dock!.width + 1);
    });
});
